// TASK-085 — 🔴 the post-migrate guard. **Exits non-zero when a journal entry has no ledger row.**
//
//   bun run db:verify
//
// `db:migrate` is wired to run this straight after, so a migrate that silently applied nothing can no longer
// be mistaken for a successful deploy.
//
// ## Why this exists
// This is the fourth time in two days that **silence + exit 0** reached production: `void recordSale`, the
// unregistered scheduled jobs, the swallowed `400`, and now three skipped migrations. A deploy step that
// cannot fail visibly is not a control. The ledger split fixes today's breakage; this is what makes the *next*
// one a red failure instead of a green deploy.
//
// Replaces `scripts/db-check-migrate.ts`, which was hardcoded to two 2026-era columns and — worse — recorded
// migrations with `hash` set to the tag string, creating the unattributable rows this task had to special-case.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  migrationHash,
  missingMigrations,
  newestCreatedAt,
  wouldApply,
  type LedgerRow,
  type OwnMigration,
} from "../src/lib/migration-ledger";
import { BO_WITNESSES as WITNESSES, judge, retiredTags } from "../src/lib/migration-witness";
import { probeAll } from "./probe-witnesses";

const OWN = "__drizzle_migrations_bo"; // must match drizzle.config.ts
const SCHEMA = "drizzle";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const sql = postgres(url);

const dir = resolve(import.meta.dir, "..", "drizzle");
const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string; when: number }>;
};
const mine: OwnMigration[] = journal.entries.map((e) => ({
  tag: e.tag,
  when: e.when,
  hash: migrationHash(readFileSync(resolve(dir, `${e.tag}.sql`), "utf8")),
}));

const exists = await sql`
  SELECT 1 FROM information_schema.tables WHERE table_schema = ${SCHEMA} AND table_name = ${OWN}
`;
const rows = exists.length
  ? ((await sql`SELECT hash, created_at FROM ${sql(SCHEMA)}.${sql(OWN)}`) as unknown as LedgerRow[])
  : [];

// ⚠️ `missing` is narrowed by the RETIRED set below — see the comment there before changing this.
const missingRaw = missingMigrations(mine, rows.map((r) => r.hash));

// TASK-086 — the ledger is only half the question. Ask the SCHEMA too, using the **same witness map** the
// seeder uses (imported, not re-stated), so the two cannot form different notions of "applied". If they
// could disagree we'd eventually get a green verify on a broken database — worse than today, because today
// it is at least red.
const witnessed = judge(WITNESSES, await probeAll(sql, WITNESSES));
await sql.end();

// 🔴 TASK-087 — RETIRED entries: never applied, never will be, never seeded, and reported EVERY run.
// They are excused from the "unrecorded in the ledger" check because otherwise this verifier is
// permanently red — and a permanently-red guard gets ignored, which makes the next REAL skip invisible.
// ⚠️ The exemption is exactly this list of tags and nothing else; a genuinely unrecorded, non-retired
// migration is untouched by it and still turns this red.
const retired = witnessed.filter((w) => w.verdict === "retired");
const retiredSet = new Set(retiredTags(witnessed));
const missing = missingRaw.filter((m) => !retiredSet.has(m.tag));

const notInSchema = witnessed.filter((w) => w.verdict !== "applied" && w.verdict !== "retired");
const ledgerHashes = new Set(rows.map((r) => r.hash));
const hashOf = new Map(mine.map((m) => [m.tag, m.hash]));
// 🔴 The dangerous disagreement: the ledger says applied, the database says it isn't.
const ledgerLies = notInSchema.filter((w) => ledgerHashes.has(hashOf.get(w.tag) ?? ""));

console.log(`Journal: ${mine.length} migration(s) · ledger ${SCHEMA}.${OWN}: ${rows.length} row(s)`);
console.log(`Schema witnesses: ${witnessed.filter((w) => w.verdict === "applied").length} applied`);

// Printed on EVERY run, pass or fail — the point is that they are visible, not that they are quiet.
if (retired.length) {
  console.log(`\nℹ️  ${retired.length} migration(s) are RETIRED — never applied, never will be, not seeded:`);
  for (const r of retired) {
    console.log(`  ${r.tag.padEnd(28)} ${r.probe}`);
    console.log(`    ${r.why}`);
  }
}

if (missing.length === 0 && ledgerLies.length === 0) {
  console.log("\n✅ every migration is recorded in the ledger AND witnessed in the schema (retired excepted).");
  process.exit(0);
}

if (ledgerLies.length) {
  console.error(
    `\n🔴 ${ledgerLies.length} migration(s) are RECORDED AS APPLIED but the schema says otherwise:\n`,
  );
  for (const w of ledgerLies) {
    console.error(`  ${w.tag.padEnd(34)} ${w.verdict}  ·  ${w.probe} → found=${w.found === null ? "n/a" : w.found}`);
    console.error(`    ${w.why}`);
  }
  console.error(
    "\n  A ledger row without the schema to back it is the failure this whole task exists to end.\n" +
      "  Do NOT restart the app. Run `bun run db:seed-ledger` (dry-run) and send the output.",
  );
}

if (missing.length === 0) {
  console.error("\nDeploy is NOT complete.");
  process.exit(1);
}

// Explain WHY, not just THAT — a silent skip and a genuinely failed statement look identical otherwise.
const newest = newestCreatedAt(rows);
console.error(`\n🔴 ${missing.length} migration(s) in the journal are NOT recorded as applied:\n`);
for (const m of missing) {
  const silent = !wouldApply(m, newest);
  console.error(
    `  ${m.tag.padEnd(34)} when=${m.when}` +
      (silent
        ? `  ⚠️ drizzle would SKIP this silently (ledger newest created_at=${newest} ≥ when)`
        : "  (drizzle would apply it — did migrate run?)"),
  );
}
if (missing.some((m) => !wouldApply(m, newest))) {
  console.error(
    "\n⚠️ A skip means this repo's ledger contains a row NEWER than these migrations — the TASK-085 failure" +
      "\n   mode. Check `migrationsTable` in drizzle.config.ts and run `bun run db:seed-ledger`.",
  );
}
console.error("\nDeploy is NOT complete. Do not restart the app against this schema.");
process.exit(1); // 🔴 the whole point
