// TASK-086 — the witness→verdict logic, proven without a database.
//
// I cannot run any of this against `sid` (and `env -u DATABASE_URL` would not protect me — that's the trap
// TASK-085 found). So the part that can be wrong in an interesting way is pure and tested here.
import { describe, expect, test } from "bun:test";
import {
  BO_WITNESSES,
  appliedTags,
  blockers,
  describeProbe,
  judge,
  retiredTags,
  type Witness,
} from "./migration-witness";

const answers = (m: Record<string, boolean | null>) => new Map(Object.entries(m));

describe("the map itself — every entry must be justifiable", () => {
  test("🔑 every journal tag has exactly one witness, and every witness has a reason", () => {
    const journal = require("../../drizzle/meta/_journal.json") as { entries: { tag: string }[] };
    expect(BO_WITNESSES.map((w) => w.tag)).toEqual(journal.entries.map((e) => e.tag));
    for (const w of BO_WITNESSES) {
      expect(w.why.length).toBeGreaterThan(60);
      expect(describeProbe(w.probe)).not.toBe("");
    }
  });

  test("🔴 0004_bo_schema witnesses its LAST object — its ledger row is what blocked scheduling", () => {
    const w = BO_WITNESSES.find((x) => x.tag === "0004_bo_schema")!;
    expect(w.probe).toEqual({ kind: "index", index: "bo_item_tag_group_uq", schema: "bo" });
  });

  test("the un-guarded baselines are marked NOT re-runnable", () => {
    for (const tag of ["0000_friendly_moonstone", "0003_even_turbo"]) {
      expect(BO_WITNESSES.find((w) => w.tag === tag)!.rerunnable).toBe(false);
    }
  });
});

describe("judge — the database answers, we don't assume", () => {
  const W: Witness[] = [
    { tag: "a", probe: { kind: "table", table: "t" }, why: "x".repeat(50), rerunnable: true },
    { tag: "b", probe: { kind: "table", table: "u" }, why: "x".repeat(50), rerunnable: false },
  ];

  test("found → applied; not found → not-applied", () => {
    const r = judge(W, answers({ a: true, b: false }));
    expect(r.map((x) => x.verdict)).toEqual(["applied", "not-applied"]);
  });

  test("🔑 an unevaluated probe is needs-human, NEVER an optimistic guess", () => {
    expect(judge(W, answers({ a: null })).map((x) => x.verdict)).toEqual(["needs-human", "needs-human"]);
  });

  test("🔴 a HALF-APPLIED migration reads as not-applied, so it re-runs and its guards absorb the rest", () => {
    // The whole point of witnessing the LAST object: the first object landed, the last didn't.
    // The verdict must be "not applied", not "applied".
    const half = judge(W, answers({ a: false, b: true }));
    expect(half[0].verdict).toBe("not-applied");
  });

  test("superseded inherits `applied` from its parent…", () => {
    const w: Witness[] = [
      ...W,
      { tag: "c", probe: { kind: "superseded-by", tag: "a" }, why: "x".repeat(50), rerunnable: false },
    ];
    expect(judge(w, answers({ a: true, b: true })).find((x) => x.tag === "c")!.verdict).toBe("applied");
  });

  test("🔑 …and refuses to inherit anything else — an unproven parent means needs-human", () => {
    const w: Witness[] = [
      ...W,
      { tag: "c", probe: { kind: "superseded-by", tag: "a" }, why: "x".repeat(50), rerunnable: false },
    ];
    expect(judge(w, answers({ a: false, b: true })).find((x) => x.tag === "c")!.verdict).toBe("needs-human");
    expect(judge(w, answers({ b: true })).find((x) => x.tag === "c")!.verdict).toBe("needs-human");
  });

  test("inheritance works regardless of declaration order (two-pass)", () => {
    const w: Witness[] = [
      { tag: "c", probe: { kind: "superseded-by", tag: "a" }, why: "x".repeat(50), rerunnable: false },
      ...W,
    ];
    expect(judge(w, answers({ a: true, b: true })).find((x) => x.tag === "c")!.verdict).toBe("applied");
  });
});

describe("🔴 blockers — what must HALT the operator", () => {
  const W: Witness[] = [
    { tag: "safe", probe: { kind: "table", table: "t" }, why: "x".repeat(50), rerunnable: true },
    { tag: "unsafe", probe: { kind: "table", table: "u" }, why: "x".repeat(50), rerunnable: false },
  ];

  test("🔑 a not-applied, NOT re-runnable migration halts — this is the 0006 case", () => {
    const b = blockers(judge(W, answers({ safe: false, unsafe: false })));
    expect(b.map((x) => x.tag)).toEqual(["unsafe"]);
  });

  test("a not-applied but re-runnable migration does NOT halt — db:migrate can handle it", () => {
    expect(blockers(judge(W, answers({ safe: false, unsafe: true })))).toHaveLength(0);
  });

  test("needs-human always halts, even when re-runnable", () => {
    expect(blockers(judge(W, answers({ safe: null, unsafe: true }))).map((x) => x.tag)).toEqual(["safe"]);
  });

  test("everything applied → nothing halts", () => {
    expect(blockers(judge(W, answers({ safe: true, unsafe: true })))).toHaveLength(0);
  });
});

describe("appliedTags — what gets seeded", () => {
  test("only 'applied' seeds; not-applied and needs-human do not", () => {
    const W: Witness[] = [
      { tag: "a", probe: { kind: "table", table: "t" }, why: "x".repeat(50), rerunnable: true },
      { tag: "b", probe: { kind: "table", table: "u" }, why: "x".repeat(50), rerunnable: true },
      { tag: "c", probe: { kind: "table", table: "v" }, why: "x".repeat(50), rerunnable: true },
    ];
    expect(appliedTags(judge(W, answers({ a: true, b: false, c: null })))).toEqual(["a"]);
  });

  test("🔑 one row per journal entry, no duplicates — and the RETIRED ones are excluded (TASK-087)", () => {
    const r = judge(BO_WITNESSES, new Map(BO_WITNESSES.map((w) => [w.tag, true])));
    expect(new Set(appliedTags(r)).size).toBe(appliedTags(r).length);
    // Every entry is accounted for exactly once, but retired entries get NO ledger row: a row would be a
    // claim that they were applied, which is untrue. 6 journal entries = 4 seeded + 2 retired.
    expect(appliedTags(r).length + retiredTags(r).length).toBe(BO_WITNESSES.length);
    expect(retiredTags(r)).toEqual(["0001_item_pl", "0002_item_external"]);
  });
});

// ── TASK-087 — the third verdict: `retired` ─────────────────────────────────────────────────────────
describe("🔴 retired — visible, justified, and NOT a way to switch the guard off", () => {
  const RETIRED: Witness[] = [
    {
      tag: "0001_item_pl",
      probe: { kind: "retired", since: "REQ-006 / TASK-027" },
      why: "x".repeat(70),
      rerunnable: false,
    },
    { tag: "live", probe: { kind: "table", table: "t" }, why: "x".repeat(70), rerunnable: true },
  ];

  test("🔑 0001 and 0002 are classified retired, citing REQ-006/TASK-027", () => {
    for (const tag of ["0001_item_pl", "0002_item_external"]) {
      const w = BO_WITNESSES.find((x) => x.tag === tag)!;
      expect(w.probe).toEqual({ kind: "retired", since: "REQ-006 / TASK-027" });
      expect(w.why).toContain("ops");
      expect(w.rerunnable).toBe(false); // never attempt: "apply" = hand-run SQL against a dead schema
    }
  });

  test("the verdict is `retired` — resolved without a query, like superseded-by", () => {
    expect(judge(RETIRED, new Map()).find((r) => r.tag === "0001_item_pl")!.verdict).toBe("retired");
  });

  test("🔑 retired NEVER gets a ledger row — a row would claim it was applied, which is untrue", () => {
    const r = judge(RETIRED, answers({ live: true }));
    expect(appliedTags(r)).toEqual(["live"]);
    expect(retiredTags(r)).toEqual(["0001_item_pl"]);
  });

  test("🔑 retired does NOT block — verify stays green, because a permanently-red guard gets ignored", () => {
    expect(blockers(judge(RETIRED, answers({ live: true })))).toHaveLength(0);
  });

  test("🔴 …and a genuinely unrecorded, NON-retired migration still goes red", () => {
    // The other half. Without this, "retired" would be indistinguishable from switching the check off.
    const r = judge(RETIRED, answers({ live: false }));
    expect(r.find((x) => x.tag === "live")!.verdict).toBe("not-applied");
    expect(retiredTags(r)).not.toContain("live"); // the exemption is exactly the retired tags, nothing else
  });

  test("🔴 a non-retired migration that is not-applied AND not re-runnable still HALTS", () => {
    const w: Witness[] = [
      RETIRED[0],
      { tag: "risky", probe: { kind: "table", table: "t" }, why: "x".repeat(70), rerunnable: false },
    ];
    expect(blockers(judge(w, answers({ risky: false }))).map((x) => x.tag)).toEqual(["risky"]);
  });

  test("describeProbe explains WHY, so the operator learns the reason and not just the verdict", () => {
    expect(describeProbe(RETIRED[0].probe)).toContain("REQ-006 / TASK-027");
    expect(describeProbe(RETIRED[0].probe)).toContain("never be applied");
  });
});
