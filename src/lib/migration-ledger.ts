// TASK-085 — migration-ledger reasoning, kept pure so the dangerous decisions are testable WITHOUT a database.
//
// ## The outage this exists to prevent
// Neither repo set `migrationsTable`, so both wrote to the same default `drizzle.__drizzle_migrations`.
// drizzle's migrator (`pg-core/dialect`) does:
//
//     select id, hash, created_at from <ledger> order by created_at desc limit 1
//     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) → apply
//
// **One row, compared by timestamp, never by hash.** Backoffice's newest `when` (1785542400000) is far above
// scheduling's entire journal (max 1783000000013), so scheduling's `db:migrate` applies **nothing and exits 0**
// — permanently, not just for 0015–0017.
//
// ## ⚠️ Why an empty new ledger is more dangerous than the bug
// `!lastDbMigration` → **every migration from 0000 re-applies** on a live database. So the new ledger must be
// SEEDED from the shared one before the first migrate. We copy what's already applied rather than guessing it.

import { createHash } from "node:crypto";

/** Exactly what drizzle stores: sha256 of the raw `.sql` file text. Same input ⇒ same hash, so a ledger row
 *  can be attributed to the repo that owns that file — no list of migration numbers to get wrong. */
export const migrationHash = (sqlText: string): string =>
  createHash("sha256").update(sqlText).digest("hex");

export interface OwnMigration {
  tag: string;
  when: number;
  hash: string;
}

export interface LedgerRow {
  hash: string;
  /** drizzle writes `folderMillis` here; `bigint` comes back as a string from postgres. */
  created_at: number | string;
}

export interface Attribution {
  /** Rows whose hash matches one of this repo's files — copy these across verbatim. */
  mine: Array<{ row: LedgerRow; tag: string; via: "hash" | "legacy-tag" }>;
  /** Rows that belong to the other repo, or that nothing here can explain. Never copied. */
  foreign: LedgerRow[];
}

/**
 * Split a shared ledger into "rows this repo owns" and "everything else", **by hash**.
 *
 * ⚠️ One real special case, found in the evidence rather than imagined: the legacy
 * `scripts/db-check-migrate.ts` recorded migrations with `hash` set to the **tag string**
 * (`'0004_teacher_work_days'`), not a sha256. Those rows are genuinely ours and must come across, or the
 * post-migrate verifier would report 0004/0005 as unrecorded forever. They're reported separately
 * (`via: "legacy-tag"`) so the operator can see they were matched by a different rule.
 */
export function attributeLedger(rows: LedgerRow[], mine: OwnMigration[]): Attribution {
  const byHash = new Map(mine.map((m) => [m.hash, m.tag]));
  const byTag = new Map(mine.map((m) => [m.tag, m.tag]));
  const out: Attribution = { mine: [], foreign: [] };

  for (const row of rows) {
    const byHashTag = byHash.get(row.hash);
    if (byHashTag) {
      out.mine.push({ row, tag: byHashTag, via: "hash" });
      continue;
    }
    const legacyTag = byTag.get(row.hash);
    if (legacyTag) {
      out.mine.push({ row, tag: legacyTag, via: "legacy-tag" });
      continue;
    }
    out.foreign.push(row);
  }
  return out;
}

/** Rows to insert, skipping anything the target ledger already has — so the seed is safe to re-run. */
export function rowsToInsert(
  attributed: Attribution["mine"],
  alreadyPresentHashes: Iterable<string>,
): Attribution["mine"] {
  const present = new Set(alreadyPresentHashes);
  return attributed.filter((a) => !present.has(a.row.hash));
}

/**
 * 🔴 The guard. Journal entries with no row in this repo's ledger — i.e. migrations that did **not** apply.
 *
 * A deploy step that cannot fail visibly is not a control. This is what makes the next skipped migration a
 * red failure instead of a green deploy.
 */
export function missingMigrations(mine: OwnMigration[], ledgerHashes: Iterable<string>): OwnMigration[] {
  const present = new Set(ledgerHashes);
  return mine.filter((m) => !present.has(m.hash) && !present.has(m.tag));
}

/**
 * Would drizzle actually apply this migration, given the ledger's newest `created_at`? Mirrors the migrator's
 * own condition, so we can explain a silent skip instead of only detecting it.
 */
export const wouldApply = (m: OwnMigration, newestCreatedAt: number | null): boolean =>
  newestCreatedAt === null || newestCreatedAt < m.when;

/** The newest `created_at` in a ledger — the single value drizzle's decision hangs on. */
export function newestCreatedAt(rows: LedgerRow[]): number | null {
  if (rows.length === 0) return null;
  return Math.max(...rows.map((r) => Number(r.created_at)));
}
