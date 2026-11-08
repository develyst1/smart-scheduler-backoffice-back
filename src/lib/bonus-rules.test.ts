import { describe, expect, test } from "bun:test";
import {
  bangkokDateOf,
  bangkokMonthOf,
  bonus100Candidates,
  bonus50Candidates,
  DEFAULT_RULES,
  isRenewalPair,
  monthWindow,
  resolveCoachShares,
  type BonusRules,
  type PrevRef,
  type PurchaseKind,
  type PurchaseRow,
} from "./bonus-rules";

// TASK-863 — the Bonus 50 / 100 rules on plain rows. Every test names the rule it pins and fails when that rule's code is
// removed (the mutation set run for the report proves it). No database.

const rules = (over: Partial<BonusRules> = {}): BonusRules => ({ ...DEFAULT_RULES, ...over });
let n = 0;
const child = { id: "kid-1", name: "Nong A", nickname: "Aa" };

/** A purchase made on 2026-10-15 (Bangkok noon). */
const purchase = (over: Partial<PurchaseRow> = {}): PurchaseRow => {
  n += 1;
  return { kind: "COURSE", id: `p-${n}`, createdAt: "2026-10-15T05:00:00Z", isDuo: false, child, trial: null, prev: null, ...over };
};
const withTrial = (over: Partial<PurchaseRow> = {}, trialDate = "2026-09-20"): PurchaseRow =>
  purchase({ trial: { bookingId: "trial-1", date: trialDate, subject: "Skateboard", coachId: "coach-trial" }, ...over });
const prevOf = (over: Partial<PrevRef> = {}): PrevRef => ({
  kind: "COURSE",
  id: "old-1",
  createdAt: "2026-06-01T05:00:00Z",
  firstTeacherId: "coach-first",
  latestTeacherId: null,
  coachChangedAt: null,
  bonus100Pick: null,
  firstAttendedDate: "2026-06-08",
  ...over,
});
const renewal = (kind: PurchaseKind, prevKind: PurchaseKind, prevOver: Partial<PrevRef> = {}, over: Partial<PurchaseRow> = {}): PurchaseRow =>
  purchase({ kind, prev: prevOf({ kind: prevKind, ...prevOver }), ...over });

describe("Bonus 50 — a 1st Trial, then a course OR a voucher", () => {
  test("a course bought after a trial is a candidate, for the TRIAL's coach", () => {
    const [c] = bonus50Candidates([withTrial()], rules());
    expect(c).toMatchObject({ purchaseKind: "COURSE", coachId: "coach-trial", trialBookingId: "trial-1", trialDate: "2026-09-20", trialSubject: "Skateboard", childId: "kid-1", childNickname: "Aa", date: "2026-10-15" });
  });
  test("a voucher bought after a trial is a candidate too", () => {
    expect(bonus50Candidates([withTrial({ kind: "VOUCHER" })], rules()).map((c) => c.purchaseKind)).toEqual(["VOUCHER"]);
  });
  test("a purchase with no trial link is NOT a candidate", () => {
    expect(bonus50Candidates([purchase()], rules())).toEqual([]);
  });
  test("across sports counts (4A): the trial's sport is carried, never compared with the purchase", () => {
    const [c] = bonus50Candidates([withTrial({ id: "course-surf" })], rules());
    expect(c?.trialSubject).toBe("Skateboard");
    expect(c?.coachId).toBe("coach-trial");
  });
  test("a DUO purchase says so", () => {
    expect(bonus50Candidates([withTrial({ isDuo: true })], rules())[0]?.isDuo).toBe(true);
  });
  test("no time limit: a trial a year before still pays", () => {
    expect(bonus50Candidates([withTrial({}, "2025-10-01")], rules())).toHaveLength(1);
  });

  describe("go-live (cut-off checks apply ONLY when goLiveDate is set)", () => {
    const GO = "2026-10-01";
    test("no go-live date ⇒ no cut-off at all, even for an old purchase", () => {
      expect(bonus50Candidates([withTrial({ createdAt: "2020-01-01T05:00:00Z" }, "2019-12-01")], rules({ goLiveDate: null }))).toHaveLength(1);
    });
    test("a trial BEFORE go-live with bonus50TrialBeforeGoLive OFF ⇒ excluded (S13: both ends after go-live)", () => {
      expect(bonus50Candidates([withTrial({}, "2026-09-20")], rules({ goLiveDate: GO, bonus50TrialBeforeGoLive: false }))).toEqual([]);
    });
    test("…and ON ⇒ included (a pre-go-live trial still pays if bought after)", () => {
      expect(bonus50Candidates([withTrial({}, "2026-09-20")], rules({ goLiveDate: GO, bonus50TrialBeforeGoLive: true }))).toHaveLength(1);
    });
    test("a trial AFTER go-live is included with the switch off", () => {
      expect(bonus50Candidates([withTrial({}, "2026-10-05")], rules({ goLiveDate: GO, bonus50TrialBeforeGoLive: false }))).toHaveLength(1);
    });
    test("a purchase BEFORE go-live is never a candidate, whatever the trial switch says", () => {
      const early = withTrial({ createdAt: "2026-09-25T05:00:00Z" }, "2026-09-20");
      expect(bonus50Candidates([early], rules({ goLiveDate: GO, bonus50TrialBeforeGoLive: true }))).toEqual([]);
    });
    test("go-live day itself is inside (the boundary is inclusive)", () => {
      expect(bonus50Candidates([withTrial({ createdAt: "2026-10-01T03:00:00Z" }, "2026-10-01")], rules({ goLiveDate: GO }))).toHaveLength(1);
    });
  });
});

describe("Bonus 100 — a renewal goes to the OLD entitlement's first coach", () => {
  test("course → course is a renewal: candidate, first coach 1.0, with the old course's facts", () => {
    const [c] = bonus100Candidates([renewal("COURSE", "COURSE")], rules());
    expect(c).toMatchObject({
      purchaseKind: "COURSE",
      prevKind: "COURSE",
      prevId: "old-1",
      prevDate: "2026-06-01",
      firstCoachId: "coach-first",
      status: "RESOLVED",
      shares: [{ coachId: "coach-first", fraction: 1 }],
      prevFirstAttendedDate: "2026-06-08",
    });
  });
  test("voucher → voucher is NEVER a renewal, even with A10 on", () => {
    expect(bonus100Candidates([renewal("VOUCHER", "VOUCHER")], rules())).toEqual([]);
    expect(bonus100Candidates([renewal("VOUCHER", "VOUCHER")], rules({ renewalAcrossCourseVoucher: true }))).toEqual([]);
  });
  test("course → voucher and voucher → course: NOT by default (A10 off)…", () => {
    expect(bonus100Candidates([renewal("VOUCHER", "COURSE"), renewal("COURSE", "VOUCHER")], rules())).toEqual([]);
  });
  test("…and BOTH count with A10 on", () => {
    const got = bonus100Candidates([renewal("VOUCHER", "COURSE"), renewal("COURSE", "VOUCHER")], rules({ renewalAcrossCourseVoucher: true }));
    expect(got).toHaveLength(2);
    expect(got.map((c) => `${c.prevKind}>${c.purchaseKind}`).sort()).toEqual(["COURSE>VOUCHER", "VOUCHER>COURSE"]);
  });
  test("isRenewalPair is the one place the pair rule lives", () => {
    expect(isRenewalPair("COURSE", "COURSE", rules())).toBe(true);
    expect(isRenewalPair("VOUCHER", "VOUCHER", rules({ renewalAcrossCourseVoucher: true }))).toBe(false);
    expect(isRenewalPair("COURSE", "VOUCHER", rules())).toBe(false);
    expect(isRenewalPair("COURSE", "VOUCHER", rules({ renewalAcrossCourseVoucher: true }))).toBe(true);
  });
  test("a purchase with no previous entitlement is not a Bonus 100", () => {
    expect(bonus100Candidates([purchase()], rules())).toEqual([]);
  });
  test("across sports counts (4A): nothing compares the old and new subject", () => {
    expect(bonus100Candidates([renewal("COURSE", "COURSE")], rules())).toHaveLength(1);
  });

  describe("go-live 1A / 1B", () => {
    const GO = "2026-10-01";
    const oldBeforeGoLive = renewal("COURSE", "COURSE", { createdAt: "2026-06-01T05:00:00Z" }, { createdAt: "2026-10-15T05:00:00Z" });
    test("1A (bonus100OldCourseBeforeGoLive = true): an old course from before go-live still earns it", () => {
      expect(bonus100Candidates([oldBeforeGoLive], rules({ goLiveDate: GO, bonus100OldCourseBeforeGoLive: true }))).toHaveLength(1);
    });
    test("1B (= false): the same old course earns nothing", () => {
      expect(bonus100Candidates([oldBeforeGoLive], rules({ goLiveDate: GO, bonus100OldCourseBeforeGoLive: false }))).toEqual([]);
    });
    test("an old course from AFTER go-live is fine under 1B", () => {
      const oldAfter = renewal("COURSE", "COURSE", { createdAt: "2026-10-03T05:00:00Z" }, { createdAt: "2026-10-20T05:00:00Z" });
      expect(bonus100Candidates([oldAfter], rules({ goLiveDate: GO, bonus100OldCourseBeforeGoLive: false }))).toHaveLength(1);
    });
    test("a renewal BEFORE go-live is never a candidate", () => {
      const early = renewal("COURSE", "COURSE", {}, { createdAt: "2026-09-25T05:00:00Z" });
      expect(bonus100Candidates([early], rules({ goLiveDate: GO, bonus100OldCourseBeforeGoLive: true }))).toEqual([]);
    });
    test("no go-live date ⇒ 1A / 1B do nothing", () => {
      expect(bonus100Candidates([oldBeforeGoLive], rules({ goLiveDate: null, bonus100OldCourseBeforeGoLive: false }))).toHaveLength(1);
    });
  });
});

describe("the coach shares", () => {
  const change = { coachChangedAt: "2026-08-01T05:00:00Z", latestTeacherId: "coach-latest" };
  test("no change ⇒ the first coach, 1.0", () => {
    expect(resolveCoachShares(prevOf())).toEqual({ status: "RESOLVED", pick: null, shares: [{ coachId: "coach-first", fraction: 1 }] });
  });
  test("change + FIRST ⇒ first 1.0", () => {
    expect(resolveCoachShares(prevOf({ ...change, bonus100Pick: "FIRST" }))).toEqual({ status: "RESOLVED", pick: "FIRST", shares: [{ coachId: "coach-first", fraction: 1 }] });
  });
  test("change + LATEST ⇒ latest 1.0", () => {
    expect(resolveCoachShares(prevOf({ ...change, bonus100Pick: "LATEST" }))).toEqual({ status: "RESOLVED", pick: "LATEST", shares: [{ coachId: "coach-latest", fraction: 1 }] });
  });
  test("change + SHARE ⇒ 0.5 each, first then latest", () => {
    expect(resolveCoachShares(prevOf({ ...change, bonus100Pick: "SHARE" }))).toEqual({
      status: "RESOLVED",
      pick: "SHARE",
      shares: [
        { coachId: "coach-first", fraction: 0.5 },
        { coachId: "coach-latest", fraction: 0.5 },
      ],
    });
  });
  test("change + NO pick ⇒ UNRESOLVED, empty shares — listed, not dropped", () => {
    expect(resolveCoachShares(prevOf(change))).toEqual({ status: "UNRESOLVED", pick: null, shares: [] });
    const [c] = bonus100Candidates([renewal("COURSE", "COURSE", change)], rules());
    expect(c).toMatchObject({ status: "UNRESOLVED", shares: [], firstCoachId: "coach-first", latestCoachId: "coach-latest" });
  });
  test("change + an invalid pick is UNRESOLVED too (never guessed)", () => {
    expect(resolveCoachShares(prevOf({ ...change, bonus100Pick: "BOTH" })).status).toBe("UNRESOLVED");
  });
  test("latest = first is treated as NO change, whatever the pick", () => {
    expect(resolveCoachShares(prevOf({ coachChangedAt: "2026-08-01T05:00:00Z", latestTeacherId: "coach-first", bonus100Pick: "SHARE" }))).toEqual({
      status: "RESOLVED",
      pick: null,
      shares: [{ coachId: "coach-first", fraction: 1 }],
    });
  });
  test("a latest coach without coach_changed_at is not a change", () => {
    expect(resolveCoachShares(prevOf({ latestTeacherId: "coach-latest", coachChangedAt: null })).shares).toEqual([{ coachId: "coach-first", fraction: 1 }]);
  });
  test("an old course that was never attended (first_teacher_id NULL) is LISTED as NO_FIRST_COACH, not dropped", () => {
    expect(resolveCoachShares(prevOf({ firstTeacherId: null }))).toEqual({ status: "NO_FIRST_COACH", pick: null, shares: [] });
    const [c] = bonus100Candidates([renewal("COURSE", "COURSE", { firstTeacherId: null, firstAttendedDate: null })], rules());
    expect(c).toMatchObject({ status: "NO_FIRST_COACH", shares: [], firstCoachId: null, prevFirstAttendedDate: null });
  });
  test("a NO_FIRST_COACH wins over a change/pick (there is no first coach to pay)", () => {
    expect(resolveCoachShares(prevOf({ firstTeacherId: null, ...change, bonus100Pick: "LATEST" })).status).toBe("NO_FIRST_COACH");
  });
  test("a voucher as the old entitlement has no change columns: it reads as no change", () => {
    const [c] = bonus100Candidates([renewal("COURSE", "VOUCHER", { latestTeacherId: null, coachChangedAt: null, bonus100Pick: null })], rules({ renewalAcrossCourseVoucher: true }));
    expect(c).toMatchObject({ prevKind: "VOUCHER", status: "RESOLVED", shares: [{ coachId: "coach-first", fraction: 1 }] });
  });
});

describe("the month a bonus falls in = the PURCHASE's created_at, in Bangkok time", () => {
  test("23:30 on the 31st (UTC+7) is still that month, not the next", () => {
    // 2026-10-31 23:30 Bangkok = 2026-10-31 16:30 UTC
    expect(bangkokMonthOf("2026-10-31T16:30:00Z")).toBe("2026-10");
    expect(bangkokDateOf("2026-10-31T16:30:00Z")).toBe("2026-10-31");
  });
  test("00:00 on the 1st (UTC+7) is the next month", () => {
    // 2026-11-01 00:00 Bangkok = 2026-10-31 17:00 UTC
    expect(bangkokMonthOf("2026-10-31T17:00:00Z")).toBe("2026-11");
    expect(bangkokDateOf("2026-10-31T17:00:00Z")).toBe("2026-11-01");
  });
  test("a Date and a string agree; a plain YYYY-MM-DD is already a date", () => {
    expect(bangkokDateOf(new Date("2026-10-31T16:30:00Z"))).toBe("2026-10-31");
    expect(bangkokDateOf("2026-10-14")).toBe("2026-10-14");
  });
  test("a bad date throws instead of guessing, and the error names the bad input", () => {
    expect(() => bangkokDateOf("nope")).toThrow("not a date: nope");
    expect(() => bangkokDateOf("")).toThrow("not a date: ");
  });
  test("a purchase at 23:30 on 31 Oct is a candidate for 2026-10 and NOT for 2026-11", () => {
    const late = withTrial({ createdAt: "2026-10-31T16:30:00Z" });
    expect(bonus50Candidates([late], rules(), "2026-10")).toHaveLength(1);
    expect(bonus50Candidates([late], rules(), "2026-11")).toEqual([]);
    const lateRenewal = renewal("COURSE", "COURSE", {}, { createdAt: "2026-10-31T16:30:00Z" });
    expect(bonus100Candidates([lateRenewal], rules(), "2026-10")).toHaveLength(1);
    expect(bonus100Candidates([lateRenewal], rules(), "2026-11")).toEqual([]);
  });
  test("midnight 1 Nov (Bangkok) belongs to November", () => {
    const first = withTrial({ createdAt: "2026-10-31T17:00:00Z" });
    expect(bonus50Candidates([first], rules(), "2026-11")).toHaveLength(1);
    expect(bonus50Candidates([first], rules(), "2026-10")).toEqual([]);
  });
  test("monthWindow is [00:00 on the 1st, 00:00 on the next 1st) in UTC+7", () => {
    const w = monthWindow("2026-10");
    expect(w.start.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-31T17:00:00.000Z");
  });
  test("December rolls into January of the next year", () => {
    expect(monthWindow("2026-12").end.toISOString()).toBe("2026-12-31T17:00:00.000Z");
    expect(bangkokMonthOf(monthWindow("2026-12").end)).toBe("2027-01");
  });
  test.each(["2026-13", "2026-00", "26-10", "2026-1", "2026-10-01", "", "october"])("monthWindow(%p) throws", (bad) => {
    expect(() => monthWindow(bad)).toThrow();
  });
});

describe("the system teacher ('No Teacher', is_system) is never a bonus coach — impossible by construction", () => {
  const change = { coachChangedAt: "2026-08-01T05:00:00Z", latestTeacherId: "coach-latest" };
  test("Bonus 50: a trial coached by the system teacher is NOT a candidate", () => {
    const sys = withTrial();
    sys.trial!.coachIsSystem = true;
    expect(bonus50Candidates([sys], rules())).toEqual([]);
  });
  test("Bonus 50: coachIsSystem false or absent changes nothing", () => {
    const a = withTrial();
    a.trial!.coachIsSystem = false;
    expect(bonus50Candidates([a, withTrial()], rules())).toHaveLength(2);
  });
  test("Bonus 100: the system teacher as the old entitlement's FIRST coach ⇒ no candidate (the fixture Sector asked for)", () => {
    expect(bonus100Candidates([renewal("COURSE", "COURSE", { firstTeacherIsSystem: true })], rules())).toEqual([]);
  });
  test("…whatever the pick or the change says", () => {
    for (const pick of [null, "FIRST", "LATEST", "SHARE"]) {
      expect(bonus100Candidates([renewal("COURSE", "COURSE", { ...change, bonus100Pick: pick, firstTeacherIsSystem: true })], rules())).toEqual([]);
    }
  });
  test("Bonus 100: LATEST or SHARE that would pay a system LATEST coach ⇒ no candidate", () => {
    expect(bonus100Candidates([renewal("COURSE", "COURSE", { ...change, bonus100Pick: "LATEST", latestTeacherIsSystem: true })], rules())).toEqual([]);
    expect(bonus100Candidates([renewal("COURSE", "COURSE", { ...change, bonus100Pick: "SHARE", latestTeacherIsSystem: true })], rules())).toEqual([]);
  });
  test("Bonus 100: FIRST with a system LATEST coach is still a candidate (only the first coach is paid; nothing pays the system one)", () => {
    const [c] = bonus100Candidates([renewal("COURSE", "COURSE", { ...change, bonus100Pick: "FIRST", latestTeacherIsSystem: true })], rules());
    expect(c).toMatchObject({ status: "RESOLVED", pick: "FIRST", shares: [{ coachId: "coach-first", fraction: 1 }] });
  });
  test("Bonus 100: an UNRESOLVED change to a system LATEST coach stays LISTED (no share pays it; a human still has to pick)", () => {
    const [c] = bonus100Candidates([renewal("COURSE", "COURSE", { ...change, latestTeacherIsSystem: true })], rules());
    expect(c).toMatchObject({ status: "UNRESOLVED", shares: [] });
  });
  test("an ordinary coach is untouched: the flags false give exactly the old answers", () => {
    const [c] = bonus100Candidates([renewal("COURSE", "COURSE", { ...change, bonus100Pick: "SHARE", firstTeacherIsSystem: false, latestTeacherIsSystem: false })], rules());
    expect(c?.shares).toHaveLength(2);
  });
  test("a voucher as the old entitlement is covered too (its first coach)", () => {
    expect(bonus100Candidates([renewal("COURSE", "VOUCHER", { firstTeacherIsSystem: true }, {})], rules({ renewalAcrossCourseVoucher: true }))).toEqual([]);
  });
});

describe("shape and determinism", () => {
  test("DEFAULT_RULES are the team's current readings and cannot be mutated", () => {
    expect(DEFAULT_RULES).toEqual({ goLiveDate: null, bonus50TrialBeforeGoLive: false, bonus100OldCourseBeforeGoLive: true, renewalAcrossCourseVoucher: false });
    expect(Object.isFrozen(DEFAULT_RULES)).toBe(true);
  });
  test("results are ordered by date then purchase id, whatever the input order", () => {
    const a = withTrial({ id: "b-late", createdAt: "2026-10-20T05:00:00Z" });
    const b = withTrial({ id: "a-early", createdAt: "2026-10-02T05:00:00Z" });
    const c = withTrial({ id: "a-same-day", createdAt: "2026-10-20T06:00:00Z" });
    expect(bonus50Candidates([a, b, c], rules()).map((x) => x.purchaseId)).toEqual(["a-early", "a-same-day", "b-late"]);
  });
  test("the rules do not mutate their input", () => {
    const rows = [withTrial(), renewal("COURSE", "COURSE")];
    const before = JSON.stringify(rows);
    bonus50Candidates(rows, rules());
    bonus100Candidates(rows, rules());
    expect(JSON.stringify(rows)).toBe(before);
  });
  test("one purchase can be BOTH a Bonus 50 and a Bonus 100 (trial then renewal): each list has it", () => {
    const both = purchase({
      trial: { bookingId: "t", date: "2026-09-20", subject: "Skateboard", coachId: "coach-trial" },
      prev: prevOf(),
    });
    expect(bonus50Candidates([both], rules())).toHaveLength(1);
    expect(bonus100Candidates([both], rules())).toHaveLength(1);
  });
  test("this module is pure: it imports nothing", async () => {
    const src = await Bun.file(new URL("./bonus-rules.ts", import.meta.url)).text();
    expect(src).not.toMatch(/^import\s/m);
  });
});
