// TASK-085 — the ledger decisions, proven without a database.
//
// I cannot run any of this against a real DB (I don't touch real environments), so the parts that could go
// wrong are pure and tested here: attribution by hash, idempotency of the seed, and — the one Sober asked me
// to actually prove fails — the post-migrate guard.
import { describe, expect, test } from "bun:test";
import {
  attributeLedger,
  migrationHash,
  missingMigrations,
  newestCreatedAt,
  rowsToInsert,
  wouldApply,
  type LedgerRow,
  type OwnMigration,
} from "./migration-ledger";

const mk = (tag: string, when: number, sqlText: string): OwnMigration => ({
  tag,
  when,
  hash: migrationHash(sqlText),
});

const MINE = [
  mk("0000_init", 1_000, "create table a();"),
  mk("0001_more", 1_001, "create table b();"),
];
const THEIRS: LedgerRow = { hash: migrationHash("create schema bo;"), created_at: 9_999 };

describe("migrationHash — must match what drizzle stores, or nothing attributes", () => {
  test("sha256 of the raw file text, deterministic", () => {
    expect(migrationHash("create table a();")).toBe(migrationHash("create table a();"));
    expect(migrationHash("create table a();")).toHaveLength(64);
  });

  test("a one-character difference is a different migration", () => {
    expect(migrationHash("create table a();")).not.toBe(migrationHash("create table a() ;"));
  });
});

describe("attributeLedger — copy what's applied, never guess it", () => {
  test("🔑 rows matching this repo's files come across; the other repo's row does NOT", () => {
    const rows: LedgerRow[] = [
      { hash: MINE[0].hash, created_at: 1_000 },
      THEIRS,
      { hash: MINE[1].hash, created_at: 1_001 },
    ];
    const a = attributeLedger(rows, MINE);
    expect(a.mine.map((m) => m.tag)).toEqual(["0000_init", "0001_more"]);
    expect(a.foreign).toEqual([THEIRS]);
  });

  test("🔑 the legacy tag-as-hash rows are still ours — found in the real ledger, not imagined", () => {
    // `scripts/db-check-migrate.ts` inserted hash = the TAG string. Miss these and the verifier would report
    // 0004/0005 as unrecorded forever.
    const a = attributeLedger([{ hash: "0000_init", created_at: 1_000 }], MINE);
    expect(a.mine).toHaveLength(1);
    expect(a.mine[0]).toMatchObject({ tag: "0000_init", via: "legacy-tag" });
    expect(a.foreign).toHaveLength(0);
  });

  test("an unrecognisable row is reported, never silently copied", () => {
    const a = attributeLedger([{ hash: "deadbeef", created_at: 5 }], MINE);
    expect(a.mine).toHaveLength(0);
    expect(a.foreign).toHaveLength(1);
  });

  test("the ORIGINAL created_at is preserved — the seed copies history, it doesn't restamp it", () => {
    const a = attributeLedger([{ hash: MINE[0].hash, created_at: 1_000 }], MINE);
    expect(a.mine[0].row.created_at).toBe(1_000);
  });
});

describe("rowsToInsert — the seed is safe to re-run", () => {
  test("🔑 running it twice inserts nothing the second time", () => {
    const a = attributeLedger(
      [
        { hash: MINE[0].hash, created_at: 1_000 },
        { hash: MINE[1].hash, created_at: 1_001 },
      ],
      MINE,
    );
    expect(rowsToInsert(a.mine, [])).toHaveLength(2); // first run
    expect(rowsToInsert(a.mine, a.mine.map((m) => m.row.hash))).toHaveLength(0); // re-run
  });

  test("a partially-seeded ledger only gets the remainder", () => {
    const a = attributeLedger(
      [
        { hash: MINE[0].hash, created_at: 1_000 },
        { hash: MINE[1].hash, created_at: 1_001 },
      ],
      MINE,
    );
    expect(rowsToInsert(a.mine, [MINE[0].hash]).map((r) => r.tag)).toEqual(["0001_more"]);
  });
});

describe("🔴 missingMigrations — the guard, PROVEN to fail", () => {
  test("🔑 a journal entry with no ledger row is reported — this is the non-zero exit", () => {
    // Sober: "a guard that has never failed isn't known to work." This is that failure, on a scratch ledger
    // missing exactly one row.
    const missing = missingMigrations(MINE, [MINE[0].hash]);
    expect(missing.map((m) => m.tag)).toEqual(["0001_more"]);
    expect(missing).not.toHaveLength(0); // ⇒ the script exits 1
  });

  test("a fully-recorded ledger reports nothing — so the guard isn't just always-red", () => {
    expect(missingMigrations(MINE, MINE.map((m) => m.hash))).toHaveLength(0);
  });

  test("an EMPTY ledger reports everything — the exact state that would re-run 0000 on live data", () => {
    expect(missingMigrations(MINE, [])).toHaveLength(MINE.length);
  });

  test("legacy tag-as-hash rows count as recorded, so they don't raise a false alarm", () => {
    expect(missingMigrations(MINE, ["0000_init", MINE[1].hash])).toHaveLength(0);
  });
});

describe("🔴 wouldApply — the outage itself, reproduced", () => {
  test("this is the bug: scheduling's whole journal is 'older' than backoffice's newest row", () => {
    const schedulingNewest = mk("0017_entitlement_source", 1_783_000_000_013, "-- x");
    const backofficeNewestCreatedAt = 1_785_542_400_000; // backoffice 0005 in the SHARED ledger
    expect(wouldApply(schedulingNewest, backofficeNewestCreatedAt)).toBe(false); // ← silent skip, exit 0
  });

  test("…and with its OWN ledger it applies again — which is the fix, not a timestamp bump", () => {
    const schedulingNewest = mk("0017_entitlement_source", 1_783_000_000_013, "-- x");
    expect(wouldApply(schedulingNewest, 1_783_000_000_012)).toBe(true);
  });

  test("🔴 an EMPTY ledger applies EVERYTHING — why seeding must happen before the first migrate", () => {
    expect(MINE.every((m) => wouldApply(m, null))).toBe(true);
  });

  test("newestCreatedAt reads the single value drizzle's decision hangs on", () => {
    expect(newestCreatedAt([{ hash: "a", created_at: "5" }, { hash: "b", created_at: 9 }])).toBe(9);
    expect(newestCreatedAt([])).toBeNull();
  });
});
