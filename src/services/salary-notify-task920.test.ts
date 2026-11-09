// TASK-920 - the Salary notification events: one feed item per pay line WRITTEN (Bonus / Transportation / Extra Hour / OT / Other), NO money in any text, idempotent keys, a failure never touches pay. DB-less.
import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES, type Bonus100Candidate, type Bonus50Candidate } from "../lib/bonus-rules";
import type { HoursDay } from "../lib/pay-rules";
import { applyBonusLines, type BonusLineStore, type DesiredLine } from "./bonus-lines.service";
import type { BonusCandidates } from "./bonus-candidates.service";
import { autoLineKey, bonusDetail, dmy, hoursText, looksLikeMoney, manualLineKey, notifyCommission, otherDetail, payLineText, transportDetail, type NotifyEvent, type NotifyFn } from "./salary-notify";
import { createSalaryService } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";
import { createTransportService, memoryTransportStore, type TransportLineStore } from "./transport.service";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // FT, car
const F = "ffffffff-ffff-4fff-8fff-ffffffffffff"; // PT + FL
const recorder = (fail = false) => {
  const events: NotifyEvent[] = [];
  const notify: NotifyFn = async (e) => {
    if (fail) return false;
    events.push(e);
    return true;
  };
  return { events, notify };
};
const day = (date: string, byType: Partial<HoursDay["byType"]>): HoursDay => {
  const t = { private: 0, duo: 0, group: 0, eca: 0, camp: 0, ...byType };
  return { date, byType: t, teachingMinutesTotal: Object.values(t).reduce((a, b) => a + b, 0) };
};
/** "money-looking" text: any amount digits we know of, a currency symbol or word. The ONLY digits a text may hold are its dd/mm/yy date and an hours count. */
const noMoney = (text: string, amounts: number[] = []) => {
  expect(text).not.toMatch(/฿|บาท|baht|satang|สตางค์|thb/i);
  for (const a of amounts) {
    for (const form of [String(a), String(a / 100), (a / 100).toFixed(2), (a / 100).toLocaleString("en-US")]) {
      const stripped = text.replace(/\d{2}\/\d{2}\/\d{2}/, ""); // the date is allowed
      expect(stripped).not.toContain(form);
    }
  }
};

describe("the text builders (pure)", () => {
  test("`<Type> · <coach> · <dd/mm/yy>` + one detail; an unknown coach is the word «coach»", () => {
    expect(dmy("2026-10-14")).toBe("14/10/26");
    expect(payLineText("OT", "Pete", "2026-10-20", "3 Hr")).toBe("OT · Pete · 20/10/26 · 3 Hr");
    expect(payLineText("Bonus", null, "2026-10-21", "Renew")).toBe("Bonus · coach · 21/10/26 · Renew");
    expect(payLineText("Commission", "  ", "2026-10-21")).toBe("Commission · coach · 21/10/26");
  });
  test("details: Bonus 50 = 1st Trial, Bonus 100 = Renew; transport = school · Round trip | One way; hours", () => {
    expect(bonusDetail("b50:p:c")).toBe("1st Trial");
    expect(bonusDetail("b100:p:c")).toBe("Renew");
    expect(transportDetail("STA", true)).toBe("STA · Round trip");
    expect(transportDetail("STA", false)).toBe("STA · One way");
    expect(hoursText(120)).toBe("2 Hr");
    expect(hoursText(90)).toBe("1.5 Hr");
    expect(hoursText(45)).toBe("0.75 Hr");
  });
  test("🔒 an Other reason is kept AS TYPED unless it could hold money (any digit, ฿ / $ / baht / บาท): then «Other item»", () => {
    expect(otherDetail("ทำอุปกรณ์เสีย")).toBe("ทำอุปกรณ์เสีย");
    expect(otherDetail("late to class")).toBe("late to class");
    for (const bad of ["200", "หัก 200 บาท", "1,000", "฿500", "fine 50 baht", "$20", "ค่าปรับ 1.5", "5 helmets", "บาท", "THB"]) expect([bad, otherDetail(bad)]).toEqual([bad, "Other item"]);
    expect(otherDetail("")).toBe("Other item");
    expect(otherDetail(null)).toBe("Other item");
    expect(looksLikeMoney("plain words")).toBe(false);
    expect(otherDetail("x".repeat(300)).length).toBeLessThanOrEqual(201);
  });
  test("the keys: an auto line = pay:<slip>:<kind>:<ref>; a manual line = pay-line:<id>", () => {
    expect(autoLineKey("s1", "extra_hour", "eh:2026-10-14")).toBe("pay:s1:extra_hour:eh:2026-10-14");
    expect(manualLineKey("L1")).toBe("pay-line:L1");
  });
});

describe("Extra Hour (the pay run)", () => {
  async function world(fail = false) {
    const store = memorySalaryStore();
    store.names.set(A, "Pete");
    const rec = recorder(fail);
    const hours: Record<string, HoursDay[]> = { [A]: [day("2026-10-14", { private: 240, group: 120 }), day("2026-10-15", { private: 240 }), day("2026-10-18", { camp: 390 })], [F]: [day("2026-10-14", { private: 120, group: 60 })] };
    const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), { readHours: async (t) => hours[t] ?? [], notify: rec.notify });
    await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    await svc.setProfile(F, { employmentType: "PT", baseSalary: 1_000_000, active: true, roles: ["PT", "FL"] });
    await svc.setFlRate(F, "private", 40_000);
    await svc.setFlRate(F, "group", 25_000);
    const period = await svc.createPeriod(2026, 10);
    return { store, svc, period, rec, hours };
  }
  test("one Extra Hour item per line INSERTED, with the hours and NO amount; FL pay emits nothing", async () => {
    const w = await world();
    await w.svc.runPeriod(w.period.id);
    expect(w.rec.events.map((e) => e.type)).toEqual(["Extra Hour", "Extra Hour"]); // 14/10 (2 Hr) and 18/10 (1.5 Hr); the FL person's lines are fl_pay: nothing
    expect(w.rec.events.map((e) => e.text).sort()).toEqual(["Extra Hour · Pete · 14/10/26 · 2 Hr", "Extra Hour · Pete · 18/10/26 · 1.5 Hr"]);
    for (const e of w.rec.events) noMoney(e.text, [70_000, 52_500, 35_000]);
    const slip = [...w.store.slips.values()].find((s) => s.teacherId === A)!;
    expect(w.rec.events.map((e) => e.key).sort()).toEqual([`pay:${slip.id}:extra_hour:eh:2026-10-14`, `pay:${slip.id}:extra_hour:eh:2026-10-18`]);
    expect(w.rec.events.map((e) => e.occurredOn).sort()).toEqual(["2026-10-14", "2026-10-18"]);
  });
  test("a re-run emits NOTHING (the lines are kept, not inserted); a NEW extra-hour day emits just that one; a changed day (updated, not inserted) emits nothing", async () => {
    const w = await world();
    await w.svc.runPeriod(w.period.id);
    w.rec.events.length = 0;
    await w.svc.runPeriod(w.period.id);
    expect(w.rec.events).toEqual([]);
    w.hours[A] = [day("2026-10-14", { private: 420 }), day("2026-10-15", { private: 240 }), day("2026-10-18", { camp: 390 }), day("2026-10-21", { private: 300 })]; // 14th changes (updated), 21st is new
    await w.svc.runPeriod(w.period.id);
    expect(w.rec.events.map((e) => e.text)).toEqual(["Extra Hour · Pete · 21/10/26 · 1 Hr"]);
  });
  test("a notify failure leaves the lines written and is counted as notifyFailed (never thrown)", async () => {
    const w = await world(true);
    const r = await w.svc.runPeriod(w.period.id);
    expect(r).toMatchObject({ created: 2, autoLines: { inserted: 4 }, notifyFailed: 2 });
    expect([...w.store.lines.values()].filter((l) => l.kind === "extra_hour").length).toBe(2);
  });
  test("notifications OFF (no notify dep) changes nothing and adds no key", async () => {
    const store = memorySalaryStore();
    const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), { readHours: async () => [day("2026-10-14", { private: 360 })] });
    await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    const p = await svc.createPeriod(2026, 10);
    const r = await svc.runPeriod(p.id);
    expect(Object.keys(r).sort()).toEqual(["autoLines", "created", "refreshed"]);
  });
});

describe("OT, Other and Merit (the manual lines)", () => {
  async function world(fail = false) {
    const store = memorySalaryStore();
    store.names.set(A, "Pete");
    const rec = recorder(fail);
    const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), { readHours: async () => [], notify: rec.notify });
    await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true, meritEligible: true });
    const period = await svc.createPeriod(2026, 10);
    await svc.runPeriod(period.id);
    const slipId = [...store.slips.values()][0]!.id;
    return { store, svc, rec, slipId };
  }
  test("OT: one item with the hours only (no amount); keyed by the line id", async () => {
    const w = await world();
    const line = await w.svc.addOt(w.slipId, { date: "2026-10-20", minutes: 180 }, "ceo");
    expect(w.rec.events).toEqual([{ type: "OT", text: "OT · Pete · 20/10/26 · 3 Hr", occurredOn: "2026-10-20", key: `pay-line:${line.id}` }]);
    noMoney(w.rec.events[0]!.text, [line.amount]);
  });
  test("OT: a notify failure keeps the line and reports notifyFailed in the response", async () => {
    const w = await world(true);
    const line = await w.svc.addOt(w.slipId, { date: "2026-10-20", minutes: 60 }, "ceo");
    expect(line).toMatchObject({ kind: "ot", notifyFailed: 1 });
    expect([...w.store.lines.values()].some((l) => l.id === line.id)).toBe(true);
  });
  test("Other (the CEO's line): the reason as typed; a reason with a number becomes «Other item»; the amount never appears", async () => {
    const w = await world();
    const a = await w.svc.addLine(w.slipId, { amount: -20_000, label: "ทำอุปกรณ์เสีย" }, "ceo");
    const b = await w.svc.addLine(w.slipId, { amount: 150_000, label: "bonus 1,500 for the event" }, "ceo");
    expect(w.rec.events.map((e) => e.text)).toEqual(["Other · Pete · 20/10/26 · ทำอุปกรณ์เสีย", "Other · Pete · 20/10/26 · Other item"]);
    expect(w.rec.events.map((e) => e.key)).toEqual([`pay-line:${a.id}`, `pay-line:${b.id}`]);
    for (const e of w.rec.events) noMoney(e.text, [20_000, 150_000]);
  });
  test("Other (the admin's entry): notifies and keeps the admin-blind response keys; Merit notifies NOTHING", async () => {
    const w = await world();
    const e = await w.svc.addEntry({ teacherId: A, year: 2026, month: 10, kind: "other", amountSatang: 5_000, label: "x", reason: "late" }, "admin-1");
    expect(Object.keys(e).sort()).toEqual(["amountSatang", "kind", "kindLabel", "label", "lineId"]); // unchanged: no notifyFailed when nothing failed
    expect(w.rec.events.map((x) => x.text)).toEqual(["Other · Pete · 20/10/26 · late"]);
    await w.svc.addEntry({ teacherId: A, year: 2026, month: 10, kind: "merit", amountSatang: 300_000, label: "Q3" }, "admin-1");
    await w.svc.addMerit(w.slipId, { amount: 100_000 }, "ceo");
    expect(w.rec.events).toHaveLength(1); // Merit is not a notification type
  });
  test("nothing is emitted for a REFUSED write (locked period): the line is not written, so no item", async () => {
    const w = await world();
    const p = (await w.svc.listPeriods())[0]!;
    await w.svc.lockPeriod(p.id);
    await expect(w.svc.addOt(w.slipId, { date: "2026-10-20", minutes: 60 }, "ceo")).rejects.toBeInstanceOf(Error);
    await expect(w.svc.addLine(w.slipId, { amount: 1, label: "x" }, "ceo")).rejects.toBeInstanceOf(Error);
    expect(w.rec.events).toEqual([]);
  });
});

describe("Bonus (applyBonusLines)", () => {
  const b50 = (): Bonus50Candidate => ({ purchaseKind: "COURSE", purchaseId: "p-50", date: "2026-10-15", isDuo: false, childId: "k1", childName: "Nong A", childNickname: "Aa", trialBookingId: "t-1", trialDate: "2026-10-10", trialSubject: "Skateboard", coachId: A });
  const b100 = (): Bonus100Candidate => ({ purchaseKind: "COURSE", purchaseId: "p-100", date: "2026-10-16", isDuo: false, childId: "k1", childName: "Nong A", childNickname: "Aa", prevKind: "COURSE", prevId: "old", prevDate: "2026-06-01", firstCoachId: A, latestCoachId: null, pick: null, status: "RESOLVED", shares: [{ coachId: A, fraction: 1 }], prevFirstAttendedDate: "2026-10-10" });
  async function world(fail = false) {
    const store = memorySalaryStore();
    const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), { readHours: async () => [] });
    await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    const period = await svc.createPeriod(2026, 10);
    await svc.runPeriod(period.id);
    const lines: BonusLineStore = {
      listAutoBonusLines: async (ids) => [...store.lines.values()].filter((l) => l.kind === "bonus" && l.source === "auto" && l.sourceRef && ids.includes(l.slipId)).map((l) => ({ slipId: l.slipId, sourceRef: l.sourceRef!, label: l.label, amountSatang: l.amountSatang })),
      insertAutoBonusLine: async (l: DesiredLine, actor) => {
        if ([...store.lines.values()].some((x) => x.kind === "bonus" && x.source === "auto" && x.slipId === l.slipId && x.sourceRef === l.sourceRef)) return "exists";
        const id = `bl-${store.lines.size + 1}`;
        store.lines.set(id, { id, slipId: l.slipId, kind: "bonus", label: l.label, amountSatang: l.amountSatang, source: "auto", createdBy: actor, sourceRef: l.sourceRef });
        return "written";
      },
    };
    const rec = recorder(fail);
    const run = (c: BonusCandidates) => applyBonusLines(period.id, DEFAULT_RULES, "ceo", { salary: svc, profiles: store, lines, candidates: async () => c, notify: rec.notify, names: async () => new Map([[A, "Pete"]]), today: () => "2026-10-20" });
    return { store, rec, run, slip: [...store.slips.values()][0]! };
  }
  test("one Bonus item per line WRITTEN: «Bonus · Pete · dd/mm/yy · 1st Trial|Renew», no amount; keyed pay:<slip>:bonus:<ref>", async () => {
    const w = await world();
    const r = await w.run({ bonus50: [b50()], bonus100: [b100()] });
    expect(r.written).toBe(2);
    expect(w.rec.events.map((e) => e.text).sort()).toEqual(["Bonus · Pete · 20/10/26 · 1st Trial", "Bonus · Pete · 20/10/26 · Renew"]);
    expect(w.rec.events.map((e) => e.key).sort()).toEqual([`pay:${w.slip.id}:bonus:b100:p-100:${A}`, `pay:${w.slip.id}:bonus:b50:p-50:${A}`]);
    for (const e of w.rec.events) {
      expect(e.type).toBe("Bonus");
      noMoney(e.text, [5_000, 10_000]);
    }
  });
  test("a re-run (the lines are `unchanged`) emits NOTHING", async () => {
    const w = await world();
    await w.run({ bonus50: [b50()], bonus100: [] });
    w.rec.events.length = 0;
    const r = await w.run({ bonus50: [b50()], bonus100: [] });
    expect(r).toMatchObject({ written: 0, unchanged: 1 });
    expect(w.rec.events).toEqual([]);
  });
  test("a notify failure leaves the bonus lines written and counts notifyFailed", async () => {
    const w = await world(true);
    const r = await w.run({ bonus50: [b50()], bonus100: [b100()] });
    expect(r).toMatchObject({ written: 2, notifyFailed: 2 });
    expect([...w.store.lines.values()].filter((l) => l.kind === "bonus").length).toBe(2);
  });
});

describe("Transportation (applyTransportLines)", () => {
  async function world(fail = false) {
    const salaryStore = memorySalaryStore();
    const salary = createSalaryService(salaryStore, () => new Date("2026-10-20T03:00:00Z"), { readHours: async () => [] });
    await salary.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true, vehicle: "car" });
    const oct = await salary.createPeriod(2026, 10);
    await salary.runPeriod(oct.id);
    const store = memoryTransportStore();
    const lines: TransportLineStore = {
      listAutoTransportLines: async (ids) => [...salaryStore.lines.values()].filter((l) => l.kind === "transport" && l.source === "auto" && l.sourceRef && ids.includes(l.slipId)).map((l) => ({ slipId: l.slipId, sourceRef: l.sourceRef!, label: l.label, amountSatang: l.amountSatang })),
      insertAutoTransportLine: async (l, actor) => {
        if ([...salaryStore.lines.values()].some((x) => x.kind === "transport" && x.source === "auto" && x.slipId === l.slipId && x.sourceRef === l.sourceRef)) return "exists";
        const id = `tl-${salaryStore.lines.size + 1}`;
        salaryStore.lines.set(id, { id, slipId: l.slipId, kind: "transport", label: l.label, amountSatang: l.amountSatang, source: "auto", createdBy: actor, sourceRef: l.sourceRef });
        return "written";
      },
    };
    const rec = recorder(fail);
    const svc = createTransportService({ store, lines, salary, profiles: salaryStore, notify: rec.notify, names: async () => new Map([[A, "Pete"]]) });
    const sta = await svc.createSchool({ name: "STA", distanceKm: 12 });
    return { svc, oct, sta, rec, salaryStore, slip: [...salaryStore.slips.values()][0]! };
  }
  test("one Transportation item per trip line WRITTEN: «Transportation · Pete · <trip date> · STA · Round trip|One way» (no km, no vehicle, no amount)", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: "2026-10-14", schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await w.svc.createTrip({ teacherId: A, date: "2026-10-15", schoolId: w.sta.id, roundTrip: false }, "x", "ceo");
    const r = await w.svc.applyTransportLines(w.oct.id, "ceo");
    expect(r.written).toBe(2);
    expect(w.rec.events.map((e) => e.text).sort()).toEqual(["Transportation · Pete · 14/10/26 · STA · Round trip", "Transportation · Pete · 15/10/26 · STA · One way"]);
    for (const e of w.rec.events) {
      expect(e.type).toBe("Transportation");
      expect(e.text).not.toMatch(/km|car|motorbike|฿/i);
      expect(e.key).toMatch(new RegExp(`^pay:${w.slip.id}:transport:trip:`));
      noMoney(e.text, [14_400, 7_200]);
    }
  });
  test("a re-run emits nothing; a notify failure keeps the lines and counts notifyFailed", async () => {
    const w = await world();
    await w.svc.createTrip({ teacherId: A, date: "2026-10-14", schoolId: w.sta.id, roundTrip: true }, "x", "ceo");
    await w.svc.applyTransportLines(w.oct.id, "ceo");
    w.rec.events.length = 0;
    expect((await w.svc.applyTransportLines(w.oct.id, "ceo")).written).toBe(0);
    expect(w.rec.events).toEqual([]);
    const f = await world(true);
    await f.svc.createTrip({ teacherId: A, date: "2026-10-14", schoolId: f.sta.id, roundTrip: true }, "x", "ceo");
    expect(await f.svc.applyTransportLines(f.oct.id, "ceo")).toMatchObject({ written: 1, notifyFailed: 1 });
    expect([...f.salaryStore.lines.values()].filter((l) => l.kind === "transport").length).toBe(1);
  });
});

describe("Commission: the helper the future writer calls (no writer exists in BB today)", () => {
  test("notifyCommission emits a Commission item keyed by the line id; a detail with money is dropped; no notifier = nothing", async () => {
    const rec = recorder();
    await notifyCommission(rec.notify, { lineId: "L9", coach: "Ploy", day: "2026-10-16", detail: "Skate bag" });
    await notifyCommission(rec.notify, { lineId: "L10", coach: "Ploy", day: "2026-10-16", detail: "100 ฿ → 150 ฿" });
    expect(rec.events.map((e) => e.text)).toEqual(["Commission · Ploy · 16/10/26 · Skate bag", "Commission · Ploy · 16/10/26"]);
    expect(rec.events.map((e) => e.key)).toEqual(["pay-line:L9", "pay-line:L10"]);
    expect(await notifyCommission(undefined, { lineId: "L11", coach: "x" })).toEqual({ failed: 0 });
  });
});

describe("a notifier that THROWS never breaks pay", () => {
  test("fire() counts a thrown notifier as one failure; the pay run still completes with the lines written", async () => {
    const store = memorySalaryStore();
    const boom: NotifyFn = async () => {
      throw new Error("db down");
    };
    const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), { readHours: async () => [day("2026-10-14", { private: 360 })], notify: boom });
    await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    const p = await svc.createPeriod(2026, 10);
    const r = await svc.runPeriod(p.id);
    expect(r).toMatchObject({ created: 1, autoLines: { inserted: 1 }, notifyFailed: 1 });
    expect([...store.lines.values()].filter((l) => l.kind === "extra_hour").length).toBe(1);
  });
});
