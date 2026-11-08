import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { ApiException } from "../lib/http";
import { DEFAULT_RULES, type Bonus100Candidate, type Bonus50Candidate } from "../lib/bonus-rules";
import { boPaySlipLine } from "../db/schema";
import {
  applyBonusLines,
  BONUS_100_SATANG,
  BONUS_50_SATANG,
  bonusLabel,
  dbBonusLineStore,
  isEligible,
  memoryBonusLineStore,
  planBonusLines,
  reconcile,
  shareSatang,
  sourceRefOf,
  type BonusLineStore,
  type DesiredLine,
  type ExistingBonusLine,
} from "./bonus-lines.service";
import { createSalaryService, type Profile } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";
import type { BonusCandidates } from "./bonus-candidates.service";

// TASK-867 — Bonus 50 / 100 as AUTO pay lines. Jason's engine runs on his in-memory store; the bonus lines are written through a
// store that shares THAT store's `lines`, so `getSlip` really shows them and the slip total is the real one. No database.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // FT
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // FT
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // PT only
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // FL only
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // STAFF (never gets a slip)
const F = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // PT + FL
const G = "99999999-9999-4999-8999-999999999999"; // FT but INACTIVE (no slip)

const SAT = "2026-10-10"; // a Saturday
const WED = "2026-10-14"; // a Wednesday

const b50 = (over: Partial<Bonus50Candidate> = {}): Bonus50Candidate => ({
  purchaseKind: "COURSE", purchaseId: "p-50", date: "2026-10-15", isDuo: false, childId: "kid-1", childName: "Nong A", childNickname: "Aa",
  trialBookingId: "t-1", trialDate: SAT, trialSubject: "Skateboard", coachId: A, ...over,
});
const b100 = (over: Partial<Bonus100Candidate> = {}): Bonus100Candidate => ({
  purchaseKind: "COURSE", purchaseId: "p-100", date: "2026-10-16", isDuo: false, childId: "kid-1", childName: "Nong A", childNickname: "Aa",
  prevKind: "COURSE", prevId: "old-1", prevDate: "2026-06-01", firstCoachId: A, latestCoachId: null, pick: null, status: "RESOLVED",
  shares: [{ coachId: A, fraction: 1 }], prevFirstAttendedDate: SAT, ...over,
});
const cands = (bonus50: Bonus50Candidate[] = [], bonus100: Bonus100Candidate[] = []): BonusCandidates => ({ bonus50, bonus100 });

async function world(nowIso = "2026-10-20T03:00:00Z") {
  const store = memorySalaryStore();
  let t = new Date(nowIso);
  const svc = createSalaryService(store, () => t, { readHours: async () => [] });
  await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true });
  await svc.setProfile(B, { employmentType: "FT", baseSalary: 1_800_000, active: true });
  await svc.setProfile(C, { employmentType: "PT", baseSalary: 1_000_000, active: true });
  await svc.setProfile(D, { employmentType: "FL", baseSalary: null, active: true });
  await svc.setProfile(E, { employmentType: "STAFF", baseSalary: 1_000_000, active: true });
  await svc.setProfile(F, { employmentType: "PT", baseSalary: 1_000_000, active: true, roles: ["PT", "FL"] });
  await svc.setProfile(G, { employmentType: "FT", baseSalary: 1_000_000, active: false });
  const period = await svc.createPeriod(2026, 10);
  await svc.runPeriod(period.id);
  // the bonus lines live in the SAME `lines` map the engine reads, with the real uniqueness rule
  const lines: BonusLineStore & { added: DesiredLine[] } = {
    added: [],
    async listAutoBonusLines(slipIds) {
      return [...store.lines.values()]
        .filter((l) => l.kind === "bonus" && l.source === "auto" && l.sourceRef && slipIds.includes(l.slipId))
        .map((l) => ({ slipId: l.slipId, sourceRef: l.sourceRef!, label: l.label, amountSatang: l.amountSatang }));
    },
    async insertAutoBonusLine(l, actor) {
      const dup = [...store.lines.values()].some((x) => x.kind === "bonus" && x.source === "auto" && x.slipId === l.slipId && x.sourceRef === l.sourceRef);
      if (dup) return "exists";
      const id = `bl-${store.lines.size + 1}`;
      store.lines.set(id, { id, slipId: l.slipId, kind: "bonus", label: l.label, amountSatang: l.amountSatang, source: "auto", createdBy: actor, sourceRef: l.sourceRef });
      lines.added.push(l);
      return "written";
    },
  };
  const slipOf = (teacherId: string) => [...store.slips.values()].find((s) => s.periodId === period.id && s.teacherId === teacherId);
  const run = (c: BonusCandidates, rules = DEFAULT_RULES, periodId = period.id) =>
    applyBonusLines(periodId, rules, "ceo-1", { salary: svc, profiles: store, lines, candidates: async () => c });
  return { store, svc, period, lines, slipOf, run, setNow: (iso: string) => (t = new Date(iso)) };
}
const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ApiException);
  expect((e as ApiException).status).toBe(status);
  if (code) expect((e as ApiException).code).toBe(code);
};

describe("the lines", () => {
  test("FT + Bonus 50 → ONE auto bonus line of 50 ฿ on the coach's slip, with the right label and source_ref", async () => {
    const w = await world();
    const r = await w.run(cands([b50()]));
    expect(r).toMatchObject({ written: 1, unchanged: 0, skipped: [], unresolved: [], orphaned: [], changed: [] });
    expect(w.lines.added).toEqual([{ slipId: w.slipOf(A)!.id, teacherId: A, sourceRef: `b50:p-50:${A}`, label: "Bonus 50 · Aa (Private)", amountSatang: BONUS_50_SATANG }]);
    expect(BONUS_50_SATANG).toBe(5000);
  });
  test("a SHARE pick → TWO lines, 50 ฿ each, on the two slips", async () => {
    const w = await world();
    const share = b100({ latestCoachId: B, pick: "SHARE", shares: [{ coachId: A, fraction: 0.5 }, { coachId: B, fraction: 0.5 }] });
    const r = await w.run(cands([], [share]));
    expect(r.written).toBe(2);
    expect(w.lines.added.map((l) => [l.teacherId, l.amountSatang, l.sourceRef])).toEqual([
      [A, 5000, `b100:p-100:${A}`],
      [B, 5000, `b100:p-100:${B}`],
    ]);
    expect(w.lines.added[0]!.slipId).toBe(w.slipOf(A)!.id);
    expect(w.lines.added[1]!.slipId).toBe(w.slipOf(B)!.id);
  });
  test("a whole Bonus 100 is 100 ฿ (10,000 satang)", async () => {
    const w = await world();
    await w.run(cands([], [b100()]));
    expect(w.lines.added[0]!.amountSatang).toBe(BONUS_100_SATANG);
    expect(BONUS_100_SATANG).toBe(10000);
  });
  test("labels use the final UI's words: Private · Duo · Voucher, nickname else name", () => {
    expect(bonusLabel("BONUS_50", { purchaseKind: "COURSE", isDuo: false, childNickname: "Aa", childName: "Nong A" })).toBe("Bonus 50 · Aa (Private)");
    expect(bonusLabel("BONUS_50", { purchaseKind: "COURSE", isDuo: true, childNickname: "Aa", childName: "Nong A" })).toBe("Bonus 50 · Aa (Duo)");
    expect(bonusLabel("BONUS_100", { purchaseKind: "VOUCHER", isDuo: false, childNickname: "Aa", childName: "Nong A" })).toBe("Bonus 100 · Aa (Voucher)");
    expect(bonusLabel("BONUS_100", { purchaseKind: "COURSE", isDuo: false, childNickname: null, childName: " Nong A " })).toBe("Bonus 100 · Nong A (Private)");
    expect(bonusLabel("BONUS_50", { purchaseKind: "COURSE", isDuo: false, childNickname: "  ", childName: "Nong A" })).toBe("Bonus 50 · Nong A (Private)");
  });
  test("source_ref is b50|b100 : purchase : coach", () => {
    expect(sourceRefOf("BONUS_50", "p1", "c1")).toBe("b50:p1:c1");
    expect(sourceRefOf("BONUS_100", "p1", "c1")).toBe("b100:p1:c1");
  });
  test("shareSatang: exact integer math, no float", () => {
    expect(shareSatang(10000, 1)).toBe(10000);
    expect(shareSatang(10000, 0.5)).toBe(5000);
    expect(shareSatang(5000, 0.5)).toBe(2500);
    expect(() => shareSatang(5001, 0.5)).toThrow(); // a half of an odd base is not a whole satang: never rounded silently
  });
  test("the lines carry kind 'bonus' and source 'auto' as the engine sees them", async () => {
    const w = await world();
    await w.run(cands([b50()]));
    const slip = await w.svc.getSlip(w.slipOf(A)!.id);
    expect(slip.lines).toEqual([expect.objectContaining({ kind: "bonus", kindLabel: "Bonus", source: "auto", amount: 5000, label: "Bonus 50 · Aa (Private)" })]);
  });
});

describe("who is eligible (R1.1): FT yes · PT only on a PT day (Sat–Sun) · FL / STAFF never", () => {
  test("a PT coach on a SATURDAY trial is paid; on a WEDNESDAY trial is not", async () => {
    const w = await world();
    const sat = await w.run(cands([b50({ coachId: C, trialDate: SAT, purchaseId: "p-sat" })]));
    expect(sat.written).toBe(1);
    const wed = await w.run(cands([b50({ coachId: C, trialDate: WED, purchaseId: "p-wed" })]));
    expect(wed.written).toBe(0);
    expect(wed.skipped).toEqual([expect.objectContaining({ reason: "NOT_ELIGIBLE", coachId: C, date: WED, bonus: "BONUS_50" })]);
  });
  test("a PT + FL person is PT on Sat–Sun (paid) and FL Mon–Fri (not)", async () => {
    const w = await world();
    expect((await w.run(cands([b50({ coachId: F, trialDate: SAT, purchaseId: "p1" })]))).written).toBe(1);
    expect((await w.run(cands([b50({ coachId: F, trialDate: WED, purchaseId: "p2" })]))).skipped[0]).toMatchObject({ reason: "NOT_ELIGIBLE" });
  });
  test("an FL coach is never paid, on any day", async () => {
    const w = await world();
    for (const d of [SAT, WED, "2026-10-11"]) {
      const r = await w.run(cands([b50({ coachId: D, trialDate: d, purchaseId: `p-${d}` })]));
      expect(r.written).toBe(0);
      expect(r.skipped[0]).toMatchObject({ reason: "NOT_ELIGIBLE", coachId: D });
    }
  });
  test("STAFF and a coach with no profile are never paid (NOT_ELIGIBLE, not 'no slip')", async () => {
    const w = await world();
    const staff = await w.run(cands([b50({ coachId: E })]));
    expect(staff.skipped[0]).toMatchObject({ reason: "NOT_ELIGIBLE" });
    const ghost = await w.run(cands([b50({ coachId: "00000000-0000-4000-8000-000000000000", purchaseId: "p-ghost" })]));
    expect(ghost.skipped[0]).toMatchObject({ reason: "NOT_ELIGIBLE" });
  });
  test("a FT coach is paid on a weekday too", async () => {
    const w = await world();
    expect((await w.run(cands([b50({ trialDate: WED })]))).written).toBe(1);
  });
  test("a Bonus 100 tests the OLD course's first ATTENDED date: PT paid on a Sunday, not on a Monday", async () => {
    const w = await world();
    const sun = await w.run(cands([], [b100({ purchaseId: "p-sun", firstCoachId: C, shares: [{ coachId: C, fraction: 1 }], prevFirstAttendedDate: "2026-10-11" })]));
    expect(sun.written).toBe(1);
    const mon = await w.run(cands([], [b100({ purchaseId: "p-mon", firstCoachId: C, shares: [{ coachId: C, fraction: 1 }], prevFirstAttendedDate: "2026-10-12" })]));
    expect(mon.written).toBe(0);
    expect(mon.skipped[0]).toMatchObject({ reason: "NOT_ELIGIBLE", date: "2026-10-12", bonus: "BONUS_100" });
  });
  test("no known date ⇒ not eligible (never guessed)", () => {
    const ft = { teacherId: A, employmentType: "FT", roles: [], baseSatang: 1, meritEligible: false, vehicle: null, active: true } as Profile;
    expect(isEligible(ft, null)).toBe(false);
    expect(isEligible(undefined, SAT)).toBe(false);
    expect(isEligible(ft, WED)).toBe(true);
  });
  test("an ineligible coach's share is simply not paid; the other coach of a SHARE still is", async () => {
    const w = await world();
    const r = await w.run(cands([], [b100({ latestCoachId: D, pick: "SHARE", shares: [{ coachId: A, fraction: 0.5 }, { coachId: D, fraction: 0.5 }] })]));
    expect(r.written).toBe(1);
    expect(r.skipped).toEqual([expect.objectContaining({ coachId: D, reason: "NOT_ELIGIBLE" })]);
  });
});

describe("idempotent: run it twice and nothing doubles", () => {
  test("the second run writes nothing and reports the same lines as unchanged", async () => {
    const w = await world();
    const c = cands([b50()], [b100({ purchaseId: "p-r", firstCoachId: B, shares: [{ coachId: B, fraction: 1 }] })]);
    const first = await w.run(c);
    const second = await w.run(c);
    expect([first.written, first.unchanged]).toEqual([2, 0]);
    expect([second.written, second.unchanged]).toEqual([0, 2]);
    expect(w.lines.added).toHaveLength(2);
    expect([...w.store.lines.values()].filter((l) => l.kind === "bonus")).toHaveLength(2);
  });
  test("a run that loses a race (the line appears between our read and our write) counts it as unchanged, never throws", async () => {
    const w = await world();
    let first = true;
    const racing: BonusLineStore = {
      listAutoBonusLines: (ids) => w.lines.listAutoBonusLines(ids),
      insertAutoBonusLine: async (l, a) => {
        if (first) {
          first = false;
          await w.lines.insertAutoBonusLine(l, "somebody-else"); // the other writer wins
        }
        return w.lines.insertAutoBonusLine(l, a);
      },
    };
    const r = await applyBonusLines(w.period.id, DEFAULT_RULES, "ceo-1", { salary: w.svc, profiles: w.store, lines: racing, candidates: async () => cands([b50()]) });
    expect([r.written, r.unchanged]).toEqual([0, 1]);
    expect([...w.store.lines.values()].filter((l) => l.kind === "bonus")).toHaveLength(1);
  });
  test("the same candidate for two coaches is two lines (the coach is in the key); the same coach for two purchases is two lines", async () => {
    const w = await world();
    const r = await w.run(cands([b50({ purchaseId: "p1" }), b50({ purchaseId: "p2" })], []));
    expect(r.written).toBe(2);
    expect(new Set(w.lines.added.map((l) => l.sourceRef)).size).toBe(2);
  });
});

describe("skips and refusals", () => {
  test("a LOCKED period → 409 LOCKED, and nothing is read or written", async () => {
    const w = await world();
    await w.svc.lockPeriod(w.period.id);
    let asked = false;
    await rejects(applyBonusLines(w.period.id, DEFAULT_RULES, "x", { salary: w.svc, profiles: w.store, lines: w.lines, candidates: async () => ((asked = true), cands([b50()])) }), 409, "LOCKED");
    expect(asked).toBe(false);
    expect(w.lines.added).toEqual([]);
  });
  test("the LAZY 12:00 lock applies too: after lock_at the same call is refused with 409 LOCKED", async () => {
    const w = await world();
    w.setNow("2026-10-31T06:00:00Z"); // after 12:00 Bangkok on the last day
    await rejects(w.run(cands([b50()])), 409, "LOCKED");
  });
  test("a CONFIRMED slip is skipped and listed; the other coach's slip still gets its line", async () => {
    const w = await world();
    w.store.slips.get(w.slipOf(A)!.id)!.status = "confirmed";
    const r = await w.run(cands([b50({ purchaseId: "pa", coachId: A }), b50({ purchaseId: "pb", coachId: B })]));
    expect(r.written).toBe(1);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: "SKIPPED_CONFIRMED", coachId: A })]);
    expect(w.lines.added[0]!.teacherId).toBe(B);
  });
  test("a locked slip inside an open period is skipped as SKIPPED_LOCKED (defensive; never written)", async () => {
    const w = await world();
    w.store.slips.get(w.slipOf(A)!.id)!.status = "locked";
    const r = await w.run(cands([b50()]));
    expect([r.written, r.skipped[0]?.reason]).toEqual([0, "SKIPPED_LOCKED"]);
  });
  test("a coach with no slip in the period (not in the run) is SKIPPED_NO_SLIP, and no slip is created", async () => {
    const w = await world();
    const slipsBefore = w.store.slips.size;
    const r = await w.run(cands([b50({ coachId: G })])); // FT but INACTIVE: no slip
    expect(r.skipped).toEqual([expect.objectContaining({ reason: "SKIPPED_NO_SLIP", coachId: G })]);
    expect(w.store.slips.size).toBe(slipsBefore);
  });
  test("an unknown period → 404 (Jason's getPeriod)", async () => {
    const w = await world();
    await rejects(w.run(cands([b50()]), DEFAULT_RULES, "00000000-0000-4000-8000-000000000000"), 404);
  });
  test("the candidates are asked for the PERIOD'S month, with the rules passed through", async () => {
    const w = await world();
    const seen: unknown[] = [];
    const rules = { ...DEFAULT_RULES, renewalAcrossCourseVoucher: true };
    await applyBonusLines(w.period.id, rules, "x", { salary: w.svc, profiles: w.store, lines: w.lines, candidates: async (m, r) => (seen.push([m, r]), cands()) });
    expect(seen).toEqual([["2026-10", rules]]);
  });
  test("a single-digit month is zero-padded: September asks for '2026-09', never '2026-9'", async () => {
    const w = await world("2026-09-10T03:00:00Z");
    const sept = await w.svc.createPeriod(2026, 9);
    const seen: string[] = [];
    await applyBonusLines(sept.id, DEFAULT_RULES, "x", { salary: w.svc, profiles: w.store, lines: w.lines, candidates: async (m) => (seen.push(m), cands()) });
    expect(seen).toEqual(["2026-09"]);
  });
});

describe("listed, not written", () => {
  test("UNRESOLVED and NO_FIRST_COACH come back with their status and write nothing", async () => {
    const w = await world();
    const r = await w.run(
      cands([], [
        b100({ purchaseId: "p-u", status: "UNRESOLVED", shares: [], pick: null, latestCoachId: B }),
        b100({ purchaseId: "p-n", status: "NO_FIRST_COACH", shares: [], firstCoachId: null, prevFirstAttendedDate: null }),
      ]),
    );
    expect(r.written).toBe(0);
    expect(r.unresolved).toEqual([
      expect.objectContaining({ purchaseId: "p-u", status: "UNRESOLVED", bonus: "BONUS_100", latestCoachId: B }),
      expect.objectContaining({ purchaseId: "p-n", status: "NO_FIRST_COACH", firstCoachId: null }),
    ]);
    expect(w.lines.added).toEqual([]);
  });
  test("an orphan: a line written earlier whose candidate is gone is LISTED and left on the slip, not deleted", async () => {
    const w = await world();
    await w.run(cands([b50()]));
    const r = await w.run(cands()); // the candidate disappeared (e.g. a purchase ended)
    expect(r.orphaned).toEqual([expect.objectContaining({ sourceRef: `b50:p-50:${A}`, label: "Bonus 50 · Aa (Private)", amountSatang: 5000, note: "NO_LONGER_A_CANDIDATE" })]);
    expect(r.written).toBe(0);
    expect([...w.store.lines.values()].filter((l) => l.kind === "bonus")).toHaveLength(1); // still there
  });
  test("a line for a candidate now UNRESOLVED is an orphan too (nothing is silently kept or dropped)", async () => {
    const w = await world();
    await w.run(cands([], [b100()]));
    const r = await w.run(cands([], [b100({ status: "UNRESOLVED", shares: [], latestCoachId: B })]));
    expect(r.orphaned).toHaveLength(1);
    expect(r.unresolved).toHaveLength(1);
  });
  test("a line for a candidate whose slip is now confirmed is NOT an orphan (it is wanted, just frozen)", async () => {
    const w = await world();
    await w.run(cands([b50()]));
    w.store.slips.get(w.slipOf(A)!.id)!.status = "confirmed";
    const r = await w.run(cands([b50()]));
    expect(r.orphaned).toEqual([]);
    expect(r.skipped).toEqual([expect.objectContaining({ reason: "SKIPPED_CONFIRMED" })]);
  });
  test("only bonus lines are judged: a manual line, an Other± line and a non-bonus auto line are never called orphans", async () => {
    const w = await world();
    await w.svc.addLine(w.slipOf(A)!.id, { amount: 1234, label: "taxi" }, "ceo-1");
    w.store.lines.set("x", { id: "x", slipId: w.slipOf(A)!.id, kind: "fl_pay", label: "FL", amountSatang: 100, source: "auto", createdBy: "auto", sourceRef: "fl:2026-10-05" });
    const r = await w.run(cands());
    expect(r.orphaned).toEqual([]);
  });
  test("an auto BONUS line with another feature's source_ref scheme is never called an orphan either (only b50: / b100: are ours)", async () => {
    const w = await world();
    w.store.lines.set("y", { id: "y", slipId: w.slipOf(A)!.id, kind: "bonus", label: "Some other bonus", amountSatang: 777, source: "auto", createdBy: "other-feature", sourceRef: "custom:123" });
    const r = await w.run(cands());
    expect(r.orphaned).toEqual([]);
    expect(w.store.lines.get("y")?.amountSatang).toBe(777); // untouched
  });
  test("a changed amount (same key, a different pick) is reported as CHANGED and NOT applied", async () => {
    const w = await world();
    await w.run(cands([], [b100({ latestCoachId: B, pick: "SHARE", shares: [{ coachId: A, fraction: 0.5 }, { coachId: B, fraction: 0.5 }] })]));
    const r = await w.run(cands([], [b100({ latestCoachId: B, pick: "FIRST", shares: [{ coachId: A, fraction: 1 }] })]));
    expect(r.changed).toEqual([expect.objectContaining({ sourceRef: `b100:p-100:${A}`, existing: expect.objectContaining({ amountSatang: 5000 }), wanted: expect.objectContaining({ amountSatang: 10000 }) })]);
    expect(r.written).toBe(0);
    expect(r.orphaned).toEqual([expect.objectContaining({ sourceRef: `b100:p-100:${B}` })]); // B's half is no longer wanted
    const a = [...w.store.lines.values()].find((l) => l.sourceRef === `b100:p-100:${A}`)!;
    expect(a.amountSatang).toBe(5000); // untouched
  });
});

describe("the slip total stays base + Σ lines (SPEC-100 §4), in integer satang", () => {
  test("a Bonus 50 and a SHARE half add exactly 5,000 + 5,000 satang to the slip total", async () => {
    const w = await world();
    const before = (await w.svc.getSlip(w.slipOf(A)!.id)).total;
    expect(before).toBe(2_500_000);
    await w.run(cands([b50()], [b100({ purchaseId: "p-s", latestCoachId: B, pick: "SHARE", shares: [{ coachId: A, fraction: 0.5 }, { coachId: B, fraction: 0.5 }] })]));
    const slip = await w.svc.getSlip(w.slipOf(A)!.id);
    expect(slip.lines.map((l) => l.amount).sort()).toEqual([5000, 5000]);
    expect(slip.total).toBe(slip.baseAmount + slip.lines.reduce((s, l) => s + l.amount, 0));
    expect(slip.total).toBe(2_510_000);
    expect(Number.isInteger(slip.total)).toBe(true);
    const overview = await w.svc.getPeriod(w.period.id);
    expect(overview.slips.find((s) => s.teacherId === B)!.total).toBe(1_800_000 + 5000);
  });
  test("a re-run does not move the total", async () => {
    const w = await world();
    await w.run(cands([b50()]));
    const t1 = (await w.svc.getSlip(w.slipOf(A)!.id)).total;
    await w.run(cands([b50()]));
    expect((await w.svc.getSlip(w.slipOf(A)!.id)).total).toBe(t1);
  });
});

describe("reconcile and plan (pure)", () => {
  const slips = new Map([[A, { id: "slip-A", status: "draft" as const }]]);
  const profiles = new Map<string, Profile>([[A, { teacherId: A, employmentType: "FT", roles: [], baseSatang: 1, meritEligible: false, vehicle: null, active: true }]]);
  test("planBonusLines is deterministic and pure", () => {
    const input = { candidates: cands([b50()]), slipByTeacher: slips, profileByTeacher: profiles };
    const before = JSON.stringify(input.candidates);
    expect(planBonusLines(input)).toEqual(planBonusLines(input));
    expect(JSON.stringify(input.candidates)).toBe(before);
  });
  test("reconcile: unchanged / to write / changed / orphaned are disjoint", () => {
    const plan = planBonusLines({ candidates: cands([b50({ purchaseId: "keep" }), b50({ purchaseId: "new" }), b50({ purchaseId: "chg" })]), slipByTeacher: slips, profileByTeacher: profiles });
    const existing: ExistingBonusLine[] = [
      { slipId: "slip-A", sourceRef: `b50:keep:${A}`, label: "Bonus 50 · Aa (Private)", amountSatang: 5000 },
      { slipId: "slip-A", sourceRef: `b50:chg:${A}`, label: "Bonus 50 · Aa (Private)", amountSatang: 4000 },
      { slipId: "slip-A", sourceRef: `b50:gone:${A}`, label: "Bonus 50 · Aa (Private)", amountSatang: 5000 },
    ];
    const r = reconcile(plan, existing);
    expect(r.unchanged).toBe(1);
    expect(r.toWrite.map((l) => l.sourceRef)).toEqual([`b50:new:${A}`]);
    expect(r.changed.map((c) => c.sourceRef)).toEqual([`b50:chg:${A}`]);
    expect(r.orphaned.map((o) => o.sourceRef)).toEqual([`b50:gone:${A}`]);
  });
});

describe("the real line store's SQL (recording fake, no connection)", () => {
  const dialect = new PgDialect();
  function fakeExec(rows: unknown[]) {
    const rec: Record<string, any> = {};
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(rows).then(res, rej);
        return (...a: any[]) => ((rec[prop] = a), chain);
      },
    });
    return { exec: { insert: (...a: any[]) => ((rec.insert = a), chain), select: (...a: any[]) => ((rec.select = a), chain) }, rec };
  }
  const line: DesiredLine = { slipId: "slip-1", teacherId: A, sourceRef: `b50:p:${A}`, label: "Bonus 50 · Aa (Private)", amountSatang: 5000 };

  test("it inserts kind 'bonus', source 'auto', the source_ref, numeric baht, the actor", async () => {
    const f = fakeExec([{ id: "new" }]);
    expect(await dbBonusLineStore(f.exec).insertAutoBonusLine(line, "ceo-1")).toBe("written");
    expect(f.rec.insert[0]).toBe(boPaySlipLine);
    expect(f.rec.values[0]).toEqual({ slipId: "slip-1", kind: "bonus", label: "Bonus 50 · Aa (Private)", amount: "50.00", source: "auto", sourceRef: `b50:p:${A}`, createdBy: "ceo-1" });
  });
  test("ON CONFLICT targets the partial unique index (slip_id, kind, source_ref) WHERE source = 'auto'", async () => {
    const f = fakeExec([{ id: "new" }]);
    await dbBonusLineStore(f.exec).insertAutoBonusLine(line, "x");
    const cfg = f.rec.onConflictDoNothing[0];
    expect(cfg.target).toEqual([boPaySlipLine.slipId, boPaySlipLine.kind, boPaySlipLine.sourceRef]);
    expect(dialect.sqlToQuery(cfg.where).sql).toContain(`"source" = 'auto'`);
  });
  test("a conflict (no row returned) is 'exists', not an error", async () => {
    const f = fakeExec([]);
    expect(await dbBonusLineStore(f.exec).insertAutoBonusLine(line, "x")).toBe("exists");
  });
  test("listing with no slips runs no query", async () => {
    const f = fakeExec([]);
    expect(await dbBonusLineStore(f.exec).listAutoBonusLines([])).toEqual([]);
    expect(f.rec.select).toBeUndefined();
  });
  test("listing maps numeric baht back to integer satang and ignores a line with no source_ref", async () => {
    const f = fakeExec([
      { slipId: "s", sourceRef: `b50:p:${A}`, label: "L", amount: "50.00" },
      { slipId: "s", sourceRef: null, label: "no ref", amount: "1.00" },
    ]);
    expect(await dbBonusLineStore(f.exec).listAutoBonusLines(["s"])).toEqual([{ slipId: "s", sourceRef: `b50:p:${A}`, label: "L", amountSatang: 5000 }]);
  });
});

describe("the memory store keeps the same uniqueness rule", () => {
  test("a second insert of the same (slip, source_ref) is 'exists'", async () => {
    const s = memoryBonusLineStore();
    const l: DesiredLine = { slipId: "s", teacherId: A, sourceRef: "b50:p:a", label: "L", amountSatang: 5000 };
    expect(await s.insertAutoBonusLine(l, "x")).toBe("written");
    expect(await s.insertAutoBonusLine(l, "y")).toBe("exists");
    expect(s.lines).toHaveLength(1);
  });
});

describe("hard limits: what this service never does", () => {
  // CODE only: the comments in the service name these calls on purpose, to explain why they are avoided.
  const code = async (p: string) =>
    (await Bun.file(new URL(p, import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  test("it never deletes and never updates a pay line, and never creates a slip", async () => {
    expect(await code("./bonus-lines.service.ts")).not.toMatch(/\.delete\(|\.update\(|deleteLine|syncAutoLines|upsertDraftSlip|insertLine\(/);
  });
  test("it does not use SalaryStore.insertLine (which drops source_ref on the real database)", async () => {
    expect(await code("./bonus-lines.service.ts")).not.toMatch(/\.insertLine\(/);
  });
  test("it writes only through the line store's single insert (one .insert( in the whole file)", async () => {
    expect((await code("./bonus-lines.service.ts")).match(/\.insert\(/g)).toHaveLength(1);
  });
});

// ───────────────────────── the route: POST /salary/periods/:id/apply-bonus (🔻 TASK-867) ─────────────────────────
// Through Jason's real router and engine on the in-memory store. Every case here ends BEFORE the database is touched
// (the guard, the id check, an unknown period, a locked period), so the route is proved without one.
import { afterAll, beforeAll } from "bun:test";
import { Hono } from "hono";
import { makeSalaryRoutes } from "../routes/salary";
import { signToken, type Role } from "../lib/jwt";

describe("the route", () => {
  const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.JWT_SECRET = "test-secret-867";
    process.env.SKIP_ADMIN_AUTH = "false";
  });
  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function setup() {
    const store = memorySalaryStore();
    const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), { readHours: async () => [] });
    await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    const period = await svc.createPeriod(2026, 10);
    const routes = makeSalaryRoutes(svc);
    const app = new Hono();
    app.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "INTERNAL", message: String(err) } }, 500)));
    app.route("/salary", routes);
    return { app, routes, svc, period };
  }
  const post = async (app: Hono, id: string, role: Role | null) =>
    app.request(`/salary/periods/${id}/apply-bonus`, { method: "POST", headers: role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {} });

  test("the route exists and is behind requireRole, like every other /salary route", async () => {
    const { routes } = await setup();
    const hit = routes.routes.filter((r) => r.method === "POST" && r.path === "/periods/:id/apply-bonus");
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.some((r) => r.handler.name === "requireRole")).toBe(true);
  });
  test("no token 401 · coach 403 · admin 403 (CEO-only)", async () => {
    const { app, period } = await setup();
    expect((await post(app, period.id, null)).status).toBe(401);
    expect((await post(app, period.id, "coach")).status).toBe(403);
    expect((await post(app, period.id, "admin")).status).toBe(403);
  });
  test("a malformed id is 404, never a database error", async () => {
    const { app } = await setup();
    expect((await post(app, "not-a-uuid", "ceo")).status).toBe(404);
  });
  test("an unknown period is 404", async () => {
    const { app } = await setup();
    expect((await post(app, "00000000-0000-4000-8000-000000000000", "ceo")).status).toBe(404);
  });
  test("a LOCKED period is 409 LOCKED through the route", async () => {
    const { app, svc, period } = await setup();
    await svc.lockPeriod(period.id);
    const res = await post(app, period.id, "ceo");
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("LOCKED");
  });
});
