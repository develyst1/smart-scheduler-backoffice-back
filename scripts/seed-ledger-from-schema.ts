// TASK-086 — seed this repo's migration ledger from **the database's own state**, not from the old ledger.
//
// ⚠️ **DRY RUN BY DEFAULT. It changes nothing unless you pass `--apply`.**
//
//   bun run db:seed-ledger            # report only — read every line before applying
//   bun run db:seed-ledger --apply    # write one row per migration the SCHEMA says is applied
//
// ## Why this replaces `db:split-ledger`
// The 2026-08-02 dry-run proved the old shared ledger is **not faithful to the database**: 9 journal entries
// unrecorded, 6 of them demonstrably live, and `0004`/`0005` recorded twice by two different mechanisms.
// A ledger written by two mechanisms cannot be assumed complete, so it can't be the input to a reconciliation.
// **The schema is the source of truth for "what is applied"; the ledger becomes an output.**
//
// Seeds **one row per journal entry** judged applied — which also resolves the duplicate rows for free.
// **The old shared `__drizzle_migrations` is never modified or dropped**: evidence and rollback.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrationHash } from "../src/lib/migration-ledger";
import {
  BO_WITNESSES as WITNESSES,
  appliedTags,
  blockers,
  judge,
} from "../src/lib/migration-witness";
import { probeAll } from "./probe-witnesses";

const OWN = "__drizzle_migrations_bo"; // must match drizzle.config.ts
const SCHEMA = "drizzle";
const REPO = "smart-scheduler-backoffice-back (bo)";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const apply = process.argv.includes("--apply");
const sql = postgres(url);

const dir = resolve(import.meta.dir, "..", "drizzle");
const journal = JSON.parse(readFileSync(resolve(dir, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};
const byTag = new Map(journal.entries.map((e) => [e.tag, e]));

console.log(`Repo: ${REPO}`);
console.log(`Journal: ${journal.entries.length} migrations · witnesses: ${WITNESSES.length}\n`);

const results = judge(WITNESSES, await probeAll(sql, WITNESSES));

const pad = (s: string, n: number) => s.padEnd(n);
console.log(pad("migration", 34) + pad("verdict", 13) + pad("re-run?", 9) + "witness");
console.log("─".repeat(120));
for (const r of results) {
  const mark =
    r.verdict === "applied"
      ? "✅"
      : r.verdict === "not-applied"
        ? "🔴"
        : r.verdict === "retired"
          ? "ℹ️ " // TASK-087 — visible every run; never seeded, never a blocker
          : "⚠️ ";
  console.log(
    pad(r.tag, 34) +
      pad(`${mark} ${r.verdict}`, 13) +
      pad(r.rerunnable ? "yes" : "NO", 9) +
      `${r.probe} → found=${r.found === null ? "n/a" : r.found}`,
  );
}

const halts = blockers(results);
if (halts.length) {
  console.log(`\n🔴 STOP — ${halts.length} entr${halts.length === 1 ? "y" : "ies"} need a human:\n`);
  for (const h of halts) {
    console.log(`  ${h.tag}  [${h.verdict}, re-runnable: ${h.rerunnable ? "yes" : "NO"}]`);
    console.log(`    witness: ${h.probe} → found=${h.found === null ? "n/a" : h.found}`);
    console.log(`    why:     ${h.why}\n`);
  }
  console.log("  Do NOT run --apply and do NOT run db:migrate until these are resolved.");
}

const applied = appliedTags(results);
const notApplied = results.filter((r) => r.verdict === "not-applied");
const retired = results.filter((r) => r.verdict === "retired");
console.log(
  `\nSummary: ${applied.length} applied · ${notApplied.length} not applied · ${retired.length} retired · ` +
    `${halts.length} need a human`,
);
if (retired.length) {
  // TASK-087 — stated, not hidden: no ledger rows are written for these, on purpose.
  console.log(
    `Retired (never applied, never will be, NOT seeded): ${retired.map((r) => r.tag).join(", ")}`,
  );
}
if (notApplied.length) {
  console.log(`After seeding, \`db:migrate\` would apply: ${notApplied.map((r) => r.tag).join(", ")}`);
}

// What's already in this repo's ledger, so the seed is idempotent.
const ownExists = await sql`
  SELECT 1 FROM information_schema.tables WHERE table_schema = ${SCHEMA} AND table_name = ${OWN}
`;
const present = new Set(
  ownExists.length
    ? ((await sql`SELECT hash FROM ${sql(SCHEMA)}.${sql(OWN)}`) as unknown as { hash: string }[]).map(
        (r) => r.hash,
      )
    : [],
);

const toInsert = applied
  .map((tag) => {
    const entry = byTag.get(tag)!;
    return {
      tag,
      when: entry.when,
      hash: migrationHash(readFileSync(resolve(dir, `${tag}.sql`), "utf8")),
    };
  })
  .filter((m) => !present.has(m.hash));

console.log(`\nLedger ${SCHEMA}.${OWN}: ${present.size} row(s) present · ${toInsert.length} to insert`);

if (halts.length) {
  console.log("\nDRY RUN — refusing to proceed while entries need a human (see STOP above).");
  await sql.end();
  process.exit(1);
}
if (toInsert.length === 0) {
  console.log("\nNothing to insert — already seeded. (Safe to re-run.)");
  await sql.end();
  process.exit(0);
}
if (!apply) {
  console.log("\nDRY RUN — nothing changed. Re-run with --apply once the table above looks right.");
  await sql.end();
  process.exit(0);
}

await sql`CREATE SCHEMA IF NOT EXISTS ${sql(SCHEMA)}`;
await sql`
  CREATE TABLE IF NOT EXISTS ${sql(SCHEMA)}.${sql(OWN)} (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )
`;
for (const m of toInsert) {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.${sql(OWN)} (hash, created_at) VALUES (${m.hash}, ${m.when})
  `;
}
console.log(`\nInserted ${toInsert.length} row(s) into ${SCHEMA}.${OWN}.`);
console.log(`The shared ${SCHEMA}.__drizzle_migrations was NOT modified — evidence and rollback.`);
console.log("Next: `bun run db:migrate` (which self-verifies).");
await sql.end();
process.exit(0);
