// TASK-878 — the automatic pay lines on the pay run (SPEC-101 link 3): FL "Freelance Hour", Extra Hour, OT, Merit. DB-less: the in-memory
// store + an injected reader. The hand example is a real period, 30/9 – 30/10/2026 (Oct 2026: 14th = Wed, 15th = Thu, 17th = Sat, 18th = Sun).
import { describe, expect, test } from "bun:test";
import { ApiException } from "../lib/http";
import { extraHourLines, flPayLines, otPaySatang, payForMinutes, roundDiv, type HoursDay } from "../lib/pay-rules";
import { createSalaryService } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";

const FT = "11111111-1111-4111-8111-111111111111"; // Ton, full-time, base 25,000.00 ฿
const MIX = "22222222-2222-4222-8222-222222222222"; // Ploy, PT + FL (FL Mon–Fri, PT Sat–Sun), base 10,000.00 ฿
const day = (date: string, m: Partial<HoursDay["byType"]>): HoursDay => {
  const byType = { private: 0, duo: 0, group: 0, eca: 0, camp: 0, ...m };
  return { date, byType, teachingMinutesTotal: Object.values(byType).reduce((a, b) => a + b, 0) };
};

// Ton: Wed 14/10 6 Hr (hours 5–6 are extra: 2 × 350) · Thu 15/10 exactly 4 Hr (none) · Sat 17/10 exactly 5 Hr (none: weekend starts at the 6th) · Sun 18/10 6.5 Hr (1.5 × 350)
const TON: HoursDay[] = [day("2026-10-14", { private: 240, group: 120 }), day("2026-10-15", { private: 240 }), day("2026-10-17", { eca: 300 }), day("2026-10-18", { camp: 390 })];
// Ploy: Wed 14/10 (FL) private 2 Hr + group 1 Hr · Thu 15/10 (FL) private 5 Hr (FL gets NO extra hour) · Fri 16/10 (FL) camp 1 Hr but NO camp rate · Sat 17/10 (PT) 6 Hr (extra 1 Hr)
const PLOY: HoursDay[] = [day("2026-10-14", { private: 120, group: 60 }), day("2026-10-15", { private: 300 }), day("2026-10-16", { camp: 60 }), day("2026-10-17", { group: 360 })];

async function setup(hours: Record<string, HoursDay[]> = { [FT]: TON, [MIX]: PLOY }) {
  const store = memorySalaryStore();
  const reads: string[] = [];
  const state = { hours };
  const svc = createSalaryService(store, () => new Date("2026-10-20T03:00:00Z"), {
    readHours: async (t, s, e) => {
      reads.push(`${t.slice(0, 2)} ${s}..${e}`);
      return state.hours[t] ?? [];
    },
  });
  await svc.setProfile(FT, { employmentType: "FT", baseSalary: 2_500_000, active: true, meritEligible: true });
  await svc.setProfile(MIX, { employmentType: "PT", baseSalary: 1_000_000, active: true, roles: ["PT", "FL"] });
  await svc.setFlRate(MIX, "private", 40_000); // 400 ฿/hr
  await svc.setFlRate(MIX, "group", 25_000); // 250 ฿/hr   (no camp rate on purpose)
  const period = await svc.createPeriod(2026, 10);
  return { store, svc, period, state, reads };
}
const slipOf = (store: ReturnType<typeof memorySalaryStore>, t: string) => [...store.slips.values()].find((s) => s.teacherId === t)!;
const linesOf = (store: ReturnType<typeof memorySalaryStore>, t: string) => [...store.lines.values()].filter((l) => l.slipId === slipOf(store, t).id);
const rejects = async (p: Promise<unknown>, status: number) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiException);
    expect((e as ApiException).status).toBe(status);
    return;
  }
  throw new Error("expected a rejection");
};

describe("the pure money rules", () => {
  test("roundDiv is half-up on integers; payForMinutes rounds ONCE", () => {
    expect(roundDiv(1, 2)).toBe(1);
    expect(roundDiv(1, 3)).toBe(0);
    expect(roundDiv(5, 10)).toBe(1);
    expect(payForMinutes(60, 35_000)).toBe(35_000);
    expect(payForMinutes(90, 35_000)).toBe(52_500);
    expect(payForMinutes(7, 40_000)).toBe(4_667); // 4666.67 → 4667
    expect(() => roundDiv(-1, 2)).toThrow();
  });
  test("OT = base ÷ 26 ÷ 8 × 1.15 per hour: 25,000 ฿ × 2 Hr = 276.44 ฿ (138.2212 ฿/hr)", () => {
    expect(otPaySatang(2_500_000, 120)).toBe(27_644);
    expect(otPaySatang(2_500_000, 60)).toBe(13_822);
    expect(otPaySatang(0, 120)).toBe(0);
    expect(otPaySatang(99_999_999_999, 1_440)).toBeGreaterThan(0); // BigInt: no precision loss on a huge base
    expect(() => otPaySatang(1.5, 60)).toThrow();
  });
  test("Extra Hour boundaries: weekday starts after 240 min, weekend after 300; PT only on PT days; FL never", () => {
    const ft = { employmentType: "FT" as const };
    expect(extraHourLines(ft, [day("2026-10-14", { private: 240 })])).toEqual([]); // Wed 4 Hr: 0
    expect(extraHourLines(ft, [day("2026-10-14", { private: 241 })])[0]!.amountSatang).toBe(payForMinutes(1, 35_000)); // 1 min over
    expect(extraHourLines(ft, [day("2026-10-17", { private: 300 })])).toEqual([]); // Sat 5 Hr: 0
    expect(extraHourLines(ft, [day("2026-10-17", { private: 360 })])[0]!.amountSatang).toBe(35_000); // Sat 6 Hr: 1 Hr
    const mix = { employmentType: "PT" as const, roles: ["PT", "FL"] as ("PT" | "FL")[] };
    expect(extraHourLines(mix, [day("2026-10-14", { private: 600 })])).toEqual([]); // a Wed of a PT+FL person is FL
    expect(extraHourLines(mix, [day("2026-10-17", { private: 360 })]).length).toBe(1); // a Sat is PT
    expect(extraHourLines({ employmentType: "FL" }, [day("2026-10-17", { private: 600 })])).toEqual([]);
  });
  test("FL pay: only on FL days; a class type with minutes and no rate is reported, not paid at 0", () => {
    const mix = { employmentType: "PT" as const, roles: ["PT", "FL"] as ("PT" | "FL")[] };
    const r = flPayLines(mix, { private: 40_000 }, [day("2026-10-14", { private: 60, camp: 30 }), day("2026-10-17", { private: 600 })]);
    expect(r.lines.map((l) => [l.sourceRef, l.amountSatang])).toEqual([["fl:2026-10-14", 40_000]]);
    expect(r.missingRates).toEqual([{ date: "2026-10-14", classType: "camp" }]);
  });
});

describe("the hand example: an FT and a PT+FL coach over 30/9 – 30/10/2026", () => {
  test("runPeriod writes exactly the lines worked out by hand", async () => {
    const { store, svc, period } = await setup();
    expect(period.periodStart).toBe("2026-09-30");
    expect(period.periodEnd).toBe("2026-10-30");
    const out = await svc.runPeriod(period.id);
    expect(out).toMatchObject({ created: 2, refreshed: 0, autoLines: { inserted: 5, updated: 0, removed: 0 } });
    expect(out.warnings).toEqual([{ teacherId: MIX, date: "2026-10-16", classType: "camp", problem: "no_fl_rate" }]);

    // Ton (FT): 14/10 6 Hr → 2 Hr × 350 = 700.00 · 18/10 6.5 Hr → 1.5 Hr × 350 = 525.00 · nothing on the 15th (4 Hr) or the 17th (5 Hr on a weekend)
    expect(linesOf(store, FT).map((l) => [l.kind, l.sourceRef, l.amountSatang, l.source]).sort()).toEqual([
      ["extra_hour", "eh:2026-10-14", 70_000, "auto"],
      ["extra_hour", "eh:2026-10-18", 52_500, "auto"],
    ]);
    // Ploy (PT+FL): 14/10 FL 2 Hr × 400 + 1 Hr × 250 = 1,050.00 · 15/10 FL 5 Hr × 400 = 2,000.00 (no extra: FL) · 16/10 camp: no rate → no line
    // · 17/10 PT: 6 Hr on a Saturday → 1 Hr × 350 = 350.00 (a PT day: Extra Hour applies; FL pay does not)
    expect(linesOf(store, MIX).map((l) => [l.kind, l.sourceRef, l.amountSatang]).sort()).toEqual([
      ["extra_hour", "eh:2026-10-17", 35_000],
      ["fl_pay", "fl:2026-10-14", 105_000],
      ["fl_pay", "fl:2026-10-15", 200_000],
    ]);
    const ov = await svc.getPeriod(period.id);
    expect(ov.slips.find((s) => s.teacherId === FT)).toMatchObject({ baseAmount: 2_500_000, total: 2_500_000 + 122_500 });
    expect(ov.slips.find((s) => s.teacherId === MIX)).toMatchObject({ baseAmount: 1_000_000, total: 1_000_000 + 340_000 });
  });

  test("each line is itemised per date, and fl_pay reads 'Freelance Hour' on the slip", async () => {
    const { store, svc, period } = await setup();
    await svc.runPeriod(period.id);
    const slip = await svc.getSlip(slipOf(store, MIX).id);
    const fl = slip.lines.find((l) => l.kind === "fl_pay" && l.label.startsWith("14/10"))!;
    expect(fl.kindLabel).toBe("Freelance Hour");
    expect(fl.label).toBe("14/10 (Wed): private 2 Hr × 400, group 1 Hr × 250");
    const eh = (await svc.getSlip(slipOf(store, FT).id)).lines.find((l) => l.label.startsWith("14/10"))!;
    expect(eh.kindLabel).toBe("Extra Hour");
    expect(eh.label).toBe("14/10 (Wed): 6 Hr → extra 2 Hr × 350");
  });

  test("reads each person's hours over the period's whole [start, end]", async () => {
    const { svc, period, reads } = await setup();
    await svc.runPeriod(period.id);
    expect(reads.sort()).toEqual(["11 2026-09-30..2026-10-30", "22 2026-09-30..2026-10-30"]);
  });
});

describe("idempotency (migration 0011's source_ref key)", () => {
  test("running twice leaves the same lines — nothing duplicated, no churn reported", async () => {
    const { store, svc, period } = await setup();
    await svc.runPeriod(period.id);
    const before = [...store.lines.values()].map((l) => [l.id, l.kind, l.sourceRef, l.amountSatang]);
    const again = await svc.runPeriod(period.id);
    expect(again.autoLines).toBeUndefined(); // 0 inserted / updated / removed → the key is omitted
    expect(again).toMatchObject({ created: 0, refreshed: 2 });
    expect([...store.lines.values()].map((l) => [l.id, l.kind, l.sourceRef, l.amountSatang])).toEqual(before);
  });

  test("a re-run follows the timetable: a changed day is rewritten, a vanished day's line is removed, a new day is added", async () => {
    const { store, svc, period, state } = await setup();
    await svc.runPeriod(period.id);
    state.hours[FT] = [day("2026-10-14", { private: 420 }), day("2026-10-21", { private: 300 })]; // 14th: 7 Hr (3 extra) · 18th gone · 21st (Wed) 5 Hr (1 extra)
    const out = await svc.runPeriod(period.id);
    expect(out.autoLines).toEqual({ inserted: 1, updated: 1, removed: 1 });
    expect(linesOf(store, FT).map((l) => [l.sourceRef, l.amountSatang]).sort()).toEqual([
      ["eh:2026-10-14", 105_000],
      ["eh:2026-10-21", 35_000],
    ]);
  });

  test("MANUAL lines (Other, OT, Merit) are never touched by a re-run", async () => {
    const { store, svc, period } = await setup();
    await svc.runPeriod(period.id);
    const slipId = slipOf(store, FT).id;
    await svc.addLine(slipId, { amount: 150_000, label: "bonus by hand" }, "ceo");
    await svc.addOt(slipId, { date: "2026-10-20", minutes: 120 }, "ceo");
    await svc.addMerit(slipId, { amount: 300_000 }, "ceo");
    await svc.runPeriod(period.id);
    await svc.runPeriod(period.id);
    expect(linesOf(store, FT).filter((l) => l.source === "manual").map((l) => l.kind).sort()).toEqual(["merit", "ot", "other"]);
  });

  test("a confirmed slip is frozen: no auto line is written, rewritten or removed", async () => {
    const { store, svc, period, state } = await setup();
    await svc.runPeriod(period.id);
    slipOf(store, FT).status = "confirmed";
    state.hours[FT] = [];
    const out = await svc.runPeriod(period.id);
    expect(out.autoLines).toBeUndefined();
    expect(linesOf(store, FT).length).toBe(2);
  });

  test("a locked period refuses the run (409 LOCKED)", async () => {
    const { svc, period } = await setup();
    await svc.lockPeriod(period.id);
    await rejects(svc.runPeriod(period.id), 409);
  });
});

describe("insertLine keeps sourceRef and a duplicate AUTO line is a no-op (Sober's defect)", () => {
  test("round-trips sourceRef; the same (slip, kind, ref) auto line twice returns the first; manual lines are unconstrained", async () => {
    const { store, svc, period } = await setup();
    await svc.runPeriod(period.id);
    const slipId = slipOf(store, FT).id;
    const a = await store.insertLine({ slipId, kind: "bonus", label: "x", amountSatang: 100, source: "auto", createdBy: "t", sourceRef: "2026-10-02" });
    expect(a.sourceRef).toBe("2026-10-02");
    const b = await store.insertLine({ slipId, kind: "bonus", label: "y", amountSatang: 999, source: "auto", createdBy: "t", sourceRef: "2026-10-02" });
    expect(b.id).toBe(a.id);
    expect(linesOf(store, FT).filter((l) => l.kind === "bonus").length).toBe(1);
    await store.insertLine({ slipId, kind: "other", label: "m", amountSatang: 1, source: "manual", createdBy: "t" });
    await store.insertLine({ slipId, kind: "other", label: "m", amountSatang: 1, source: "manual", createdBy: "t" });
    expect(linesOf(store, FT).filter((l) => l.kind === "other").length).toBe(2);
    await expect(store.insertLine({ slipId, kind: "bonus", label: "z", amountSatang: 1, source: "auto", createdBy: "t" })).rejects.toThrow();
  });
});

describe("OT (admin-entered) and Merit (typed)", () => {
  test("OT: 2 Hr on a 25,000 ฿ base = 276.44 ฿, itemised, manual-source", async () => {
    const { store, svc, period } = await setup();
    await svc.runPeriod(period.id);
    const line = await svc.addOt(slipOf(store, FT).id, { date: "2026-10-20", minutes: 120 }, "ceo");
    expect(line).toMatchObject({ kind: "ot", kindLabel: "OT", amount: 27_644, source: "manual", label: "20/10: OT 2 Hr" });
  });
  test("OT refused: outside the period · on an FL day · bad minutes · no base · locked", async () => {
    const { store, svc, period } = await setup();
    await svc.runPeriod(period.id);
    const ton = slipOf(store, FT).id;
    const ploy = slipOf(store, MIX).id;
    await rejects(svc.addOt(ton, { date: "2026-10-31", minutes: 60 }, "ceo"), 400);
    await rejects(svc.addOt(ton, { date: "2026-09-29", minutes: 60 }, "ceo"), 400);
    await rejects(svc.addOt(ton, { date: "2026-10-20", minutes: 0 }, "ceo"), 400);
    await rejects(svc.addOt(ton, { date: "2026-10-20", minutes: 90.5 }, "ceo"), 400);
    await rejects(svc.addOt(ploy, { date: "2026-10-20", minutes: 60 }, "ceo"), 400); // Tue = FL day for Ploy
    expect((await svc.addOt(ploy, { date: "2026-10-18", minutes: 60 }, "ceo")).amount).toBe(otPaySatang(1_000_000, 60)); // Sun = PT day
    await svc.lockPeriod(period.id);
    await rejects(svc.addOt(ton, { date: "2026-10-20", minutes: 60 }, "ceo"), 409);
  });
  test("Merit: only a merit-eligible person; positive integer satang; locked refused", async () => {
    const { store, svc, period } = await setup();
    await svc.runPeriod(period.id);
    const ton = slipOf(store, FT).id;
    const ploy = slipOf(store, MIX).id;
    expect(await svc.addMerit(ton, { amount: 300_000, label: "Q3 merit" }, "ceo")).toMatchObject({ kind: "merit", kindLabel: "Merit", amount: 300_000, label: "Q3 merit", source: "manual" });
    await rejects(svc.addMerit(ploy, { amount: 100 }, "ceo"), 400); // not eligible
    await rejects(svc.addMerit(ton, { amount: 0 }, "ceo"), 400);
    await rejects(svc.addMerit(ton, { amount: -5 }, "ceo"), 400);
    await rejects(svc.addMerit(ton, { amount: 1.5 }, "ceo"), 400);
    await svc.lockPeriod(period.id);
    await rejects(svc.addMerit(ton, { amount: 100 }, "ceo"), 409);
  });
});
