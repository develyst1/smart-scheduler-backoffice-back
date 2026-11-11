// TASK-922 (REQ-120 R1.8) — the month-end salary reports. No database: the reader's rows and the salary service are fakes / the in-memory store.
// (The fixtures and the shape of these checks follow Brew's first draft of the TASK, which Silver re-assigned; the code under test is Bob's.)
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import ExcelJS from "exceljs";
import { Hono } from "hono";
import { signToken, type Role } from "../lib/jwt";
import { ApiException, notFound } from "../lib/http";
import { makeSalaryRoutes } from "../routes/salary";
import { createSalaryService } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";
import * as hoursReader from "./hours-reader";
import { buildDailyReport } from "./daily-report.service";
import { row as ttRow } from "./hours-reader.fixtures";
import { PAY_KINDS, buildPayReport, buildTeachingReport, hoursOf, payToXlsx, payXlsxFor, periodIdOf, reportFilename, roleWords, teachingToXlsx, teachingXlsxFor, type PayReport, type ReportDeps, type TeachingReport } from "./salary-reports.service";

const PID = "99999999-9999-4999-8999-999999999999";
const FT = "11111111-1111-4111-8111-111111111111";
const FT2 = "11111111-1111-4111-8111-111111111112";
const PT = "22222222-2222-4222-8222-222222222222";
const PTFL = "33333333-3333-4333-8333-333333333333";
const FL = "44444444-4444-4444-8444-444444444444";
const SYS = "55555555-5555-4555-8555-555555555555"; // the system teacher ("No Teacher")
const IDLE = "66666666-6666-4666-8666-666666666666"; // an active coach with no teaching
const OFF = "77777777-7777-4777-8777-777777777777"; // an inactive profile with teaching
const PERIOD = { id: PID, year: 2026, month: 10, periodStart: "2026-09-30", periodEnd: "2026-10-30", status: "open" };

type Prof = { teacherId: string; employmentType: "FT" | "PT" | "FL"; roles: Array<"FT" | "PT" | "FL">; active: boolean };
const prof = (teacherId: string, employmentType: Prof["employmentType"], roles: Prof["roles"] = [employmentType], active = true): Prof => ({ teacherId, employmentType, roles, active });
const h = (date: string, startHour: number, hours: number, over: Record<string, unknown> = {}) =>
  ttRow({ date, startTime: `${String(startHour).padStart(2, "0")}:00:00`, endTime: `${String(startHour + hours).padStart(2, "0")}:00:00`, ...over });

function teachingDeps(o: { profiles: Prof[]; people?: string[]; rows: Record<string, hoursReader.TimetableRow[]>; period?: typeof PERIOD | null }) {
  const calls = { getPeriod: [] as unknown[][], collect: [] as string[][] };
  const deps: Required<Pick<ReportDeps, "getPeriod" | "listProfiles" | "listEntriesPeople" | "collectRows">> & Pick<ReportDeps, "getSlip"> = {
    getPeriod: async (id, opts) => {
      calls.getPeriod.push([id, opts]);
      if (o.period === null) throw notFound("Pay period not found");
      return { period: o.period ?? PERIOD, slips: [] };
    },
    getSlip: async () => ({ baseAmount: 0, total: 0, lines: [] }),
    listProfiles: async () => o.profiles,
    listEntriesPeople: async () => (o.people ?? o.profiles.map((p) => p.teacherId)).map((teacherId) => ({ teacherId, name: `Name ${teacherId.slice(0, 2)}` })),
    collectRows: async (t, a, b) => (calls.collect.push([t, a, b]), o.rows[t] ?? []),
  };
  return { deps, calls };
}
const sumOf = (days: { byType: Record<string, number> }[], k: string) => days.reduce((n, d) => n + d.byType[k]!, 0);

describe("(A) teaching summary — the reader's own minutes", () => {
  const rowsFT = [h("2026-10-14", 9, 2), h("2026-10-17", 10, 3, { bookingType: "OTHER", otherKind: "ECA" }), h("2026-10-15", 14, 1, { coStudentId: "kid" })];

  test("🔑 equals the reader's own answer for the same rows: per class, total, and the sum of the days", async () => {
    const { deps } = teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: rowsFT } });
    const rep = await buildTeachingReport(PID, deps);
    const days = await hoursReader.readHours(FT, "2026-09-30", "2026-10-30", async () => rowsFT);
    const r = rep.rows[0]!;
    expect(r.minutesByClass).toEqual({ private: sumOf(days, "private"), duo: sumOf(days, "duo"), group: 0, eca: sumOf(days, "eca"), camp: 0 });
    expect(r.minutesByClass).toEqual({ private: 120, duo: 60, group: 0, eca: 180, camp: 0 });
    expect(r.totalMinutes).toBe(days.reduce((n, d) => n + d.teachingMinutesTotal, 0));
    expect(r.totalMinutes).toBe(360);
  });
  test("🔑 equals the Daily Training Report's minutes (TASK-885) for the same coach and rows: Σ of the days = the report's total", async () => {
    const { deps } = teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: rowsFT } });
    const rep = await buildTeachingReport(PID, deps);
    let sumDaily = 0;
    for (const date of [...new Set(rowsFT.map((r) => r.date))].sort()) {
      const daily = await buildDailyReport(date, { listProfiles: async () => [prof(FT, "FT")], getFlRates: async () => [], listEntriesPeople: async () => [{ teacherId: FT }], readHours: (t, a, b) => hoursReader.readHours(t, a, b, async () => rowsFT) });
      sumDaily += daily.rows.reduce((n, r) => n + r.minutes, 0);
    }
    expect(sumDaily).toBe(rep.rows[0]!.totalMinutes);
  });
  test("🔑 weekday vs weekend by the Bangkok date: Sat and Sun are weekend, Mon–Fri weekday; they add up to the total", async () => {
    const rows = [h("2026-10-17", 9, 3), h("2026-10-18", 9, 1), h("2026-10-14", 9, 2), h("2026-10-16", 9, 1)]; // Sat, Sun, Wed, Fri
    const r = (await buildTeachingReport(PID, teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: rows } }).deps)).rows[0]!;
    expect([r.weekdayMinutes, r.weekendMinutes, r.totalMinutes]).toEqual([180, 240, 420]);
  });
  test("the period is the R1.4 range, inclusive: 30/9 and 30/10 are in, 29/9 and 31/10 are out; the reader is asked for exactly that range", async () => {
    const rows = [h("2026-09-29", 9, 5), h("2026-09-30", 9, 1), h("2026-10-30", 9, 2), h("2026-10-31", 9, 7)];
    const { deps, calls } = teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: rows } });
    const rep = await buildTeachingReport(PID, deps);
    expect(rep.rows[0]!.totalMinutes).toBe(180);
    expect(rep.rows[0]!.sessions).toBe(2); // the classes of 30/9 and 30/10 only — 29/9 and 31/10 are not counted
    expect(calls.collect).toEqual([[FT, "2026-09-30", "2026-10-30"]]);
    expect([rep.period.periodStart, rep.period.periodEnd, rep.period.label]).toEqual(["2026-09-30", "2026-10-30", "30/09/26–30/10/26"]);
  });
  test("a period that STORES its range is read for that range (not recomputed from the month)", async () => {
    const { deps, calls } = teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: [h("2026-10-14", 9, 1)] }, period: { ...PERIOD, periodStart: "2026-10-01", periodEnd: "2026-10-31" } });
    const rep = await buildTeachingReport(PID, deps);
    expect(calls.collect[0]).toEqual([FT, "2026-10-01", "2026-10-31"]);
    expect([rep.period.periodStart, rep.period.periodEnd, rep.period.label]).toEqual(["2026-10-01", "2026-10-31", "01/10/26–31/10/26"]);
  });
  test("camp minutes count in the total (all five class types)", async () => {
    const r = (await buildTeachingReport(PID, teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: [h("2026-10-14", 9, 3, { bookingType: "OTHER", otherKind: "CAMP" })] } }).deps)).rows[0]!;
    expect([r.minutesByClass.camp, r.totalMinutes, r.weekdayMinutes]).toEqual([180, 180, 180]);
  });
  test("a period row made before TASK-871 (no stored range) falls back to the computed R1.4 range", async () => {
    const { deps, calls } = teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: [h("2026-10-14", 9, 1)] }, period: { ...PERIOD, periodStart: null as never, periodEnd: null as never } });
    const rep = await buildTeachingReport(PID, deps);
    expect(calls.collect[0]).toEqual([FT, "2026-09-30", "2026-10-30"]);
    expect(rep.rows).toHaveLength(1);
  });
  test("🔑 sessions = the counted classes: a GROUP row once (not once per child), a lesson once, an ECA once; cancelled, an empty group and a skipped kind are not", async () => {
    const rows = [
      h("2026-10-14", 9, 1),
      h("2026-10-14", 11, 1, { coStudentId: "kid" }),
      ttRow({ id: "g-1", date: "2026-10-15", bookingType: "GROUP", otherKind: "GROUP", startTime: "10:00:00", endTime: "11:00:00" }),
      ttRow({ date: "2026-10-15", groupId: "g-1" }),
      ttRow({ date: "2026-10-15", groupId: "g-1" }),
      ttRow({ date: "2026-10-15", groupId: "g-1" }),
      ttRow({ id: "g-2", date: "2026-10-16", bookingType: "GROUP", otherKind: "GROUP" }),
      h("2026-10-16", 13, 1, { status: "CANCELLED" }),
      h("2026-10-16", 15, 1, { bookingType: "OTHER", otherKind: "ECA" }),
      h("2026-10-17", 9, 1, { bookingType: "OTHER", otherKind: "FREE" }),
    ];
    const r = (await buildTeachingReport(PID, teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: rows } }).deps)).rows[0]!;
    expect(r.sessions).toBe(4);
    expect(r.minutesByClass).toEqual({ private: 60, duo: 60, group: 60, eca: 60, camp: 0 });
  });
  test("rows the reader skipped add no session (a PENDING lesson, a sick-leave one)", async () => {
    const r = (await buildTeachingReport(PID, teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: [h("2026-10-14", 9, 1), h("2026-10-14", 11, 1, { status: "PENDING" }), h("2026-10-14", 13, 1, { status: "SICK_LEAVE" })] } }).deps)).rows[0]!;
    expect([r.sessions, r.totalMinutes]).toEqual([1, 60]);
  });
  test("🔑 'No Teacher' is never a row; an inactive profile and a coach with no teaching are not rows either", async () => {
    const rows = { [FT]: [h("2026-10-14", 9, 1)], [SYS]: [h("2026-10-14", 9, 5)], [OFF]: [h("2026-10-14", 9, 2)], [IDLE]: [] };
    const { deps, calls } = teachingDeps({ profiles: [prof(FT, "FT"), prof(SYS, "FT"), prof(OFF, "FT", ["FT"], false), prof(IDLE, "FT")], people: [FT, OFF, IDLE], rows });
    const rep = await buildTeachingReport(PID, deps);
    expect(rep.rows.map((r) => r.teacherId)).toEqual([FT]);
    expect(calls.collect.map((c) => c[0]).sort()).toEqual([FT, IDLE].sort());
    expect(rep.totals.totalMinutes).toBe(60);
  });
  test("role words: Full-time / Part-time / Freelance, a PT + FL person reads 'Part-time + Freelance'; rows ordered by role then id", async () => {
    const rows = Object.fromEntries([FT, FT2, PT, PTFL, FL].map((id) => [id, [h("2026-10-14", 9, 1)]]));
    const rep = await buildTeachingReport(PID, teachingDeps({ profiles: [prof(FL, "FL"), prof(PTFL, "PT", ["PT", "FL"]), prof(PT, "PT"), prof(FT2, "FT"), prof(FT, "FT")], rows }).deps);
    expect(rep.rows.map((r) => [r.teacherId, r.role])).toEqual([[FT, "Full-time"], [FT2, "Full-time"], [PT, "Part-time"], [PTFL, "Part-time + Freelance"], [FL, "Freelance"]]);
    expect(roleWords({ employmentType: "FL", roles: ["FL", "PT"] })).toBe("Part-time + Freelance");
  });
  test("🔑 totals = the same keys summed over the rows", async () => {
    const rows = { [FT]: [h("2026-10-14", 9, 2), h("2026-10-17", 9, 1)], [PT]: [h("2026-10-15", 9, 3, { coStudentId: "k" }), h("2026-10-18", 9, 2, { bookingType: "OTHER", otherKind: "ECA" })] };
    const rep = await buildTeachingReport(PID, teachingDeps({ profiles: [prof(FT, "FT"), prof(PT, "PT")], rows }).deps);
    const sum = <K extends "weekdayMinutes" | "weekendMinutes" | "totalMinutes" | "sessions">(k: K) => rep.rows.reduce((n, r) => n + r[k], 0);
    expect([rep.totals.weekdayMinutes, rep.totals.weekendMinutes, rep.totals.totalMinutes, rep.totals.sessions]).toEqual([sum("weekdayMinutes"), sum("weekendMinutes"), sum("totalMinutes"), sum("sessions")]);
    expect(rep.totals.minutesByClass).toEqual({ private: 180, duo: 180, group: 0, eca: 120, camp: 0 });
    expect(rep.totals.totalMinutes).toBe(480);
  });
  test("no money anywhere in (A); the JSON carries teacherId only, never a name", async () => {
    const rep = await buildTeachingReport(PID, teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: [h("2026-10-14", 9, 8)] } }).deps);
    expect(JSON.stringify(rep)).not.toMatch(/satang|amount|rate|pay|salary|income|baht|Name /i);
    expect(Object.keys(rep.rows[0]!).sort()).toEqual(["minutesByClass", "role", "sessions", "teacherId", "totalMinutes", "weekdayMinutes", "weekendMinutes"]);
  });
  test("an unknown period is 404 and nothing is read; the missing-rates scan is switched off for this report", async () => {
    const none = teachingDeps({ profiles: [prof(FT, "FT")], rows: {}, period: null });
    const e: any = await buildTeachingReport(PID, none.deps).catch((x) => x);
    expect([e.status, e.code]).toEqual([404, "NOT_FOUND"]);
    expect(none.calls.collect).toHaveLength(0);
    const ok = teachingDeps({ profiles: [], rows: {} });
    await buildTeachingReport(PID, ok.deps);
    expect(ok.calls.getPeriod).toEqual([[PID, { missingRates: false }]]);
  });
  test("an empty period is a valid report: no rows, zero totals", async () => {
    const rep = await buildTeachingReport(PID, teachingDeps({ profiles: [prof(FT, "FT")], rows: {} }).deps);
    expect(rep.rows).toEqual([]);
    expect(rep.totals).toEqual({ minutesByClass: { private: 0, duo: 0, group: 0, eca: 0, camp: 0 }, weekdayMinutes: 0, weekendMinutes: 0, totalMinutes: 0, sessions: 0 });
  });
});

// ───────────────────────────────── (B) salary + other income ─────────────────────────────────
interface Slip { id: string; teacherId: string; status: "draft" | "confirmed" | "locked"; teacherName?: string | null; base: number; lines: { kind: string; amount: number }[]; totalOverride?: number }
function payDeps(slips: Slip[]) {
  const reads = { getPeriod: [] as unknown[][], getSlip: [] as string[] };
  const deps = {
    getPeriod: async (id: string, opts?: { missingRates?: boolean }) => (reads.getPeriod.push([id, opts]), { period: PERIOD, slips: slips.map((s) => ({ id: s.id, teacherId: s.teacherId, teacherName: s.teacherName ?? null, status: s.status })) }),
    getSlip: async (id: string) => {
      reads.getSlip.push(id);
      const s = slips.find((x) => x.id === id)!;
      return { baseAmount: s.base, total: s.totalOverride ?? s.base + s.lines.reduce((n, l) => n + l.amount, 0), lines: s.lines };
    },
  };
  return { deps, reads };
}
const S = (id: string, teacherId: string, base: number, lines: Slip["lines"], extra: Partial<Slip> = {}): Slip => ({ id, teacherId, status: "draft", base, lines, ...extra });

describe("(B) salary + other income per person", () => {
  const SLIPS = [
    S("s-1", FT, 2_500_000, [{ kind: "extra_hour", amount: 70_000 }, { kind: "extra_hour", amount: 35_000 }, { kind: "bonus", amount: 5_000 }, { kind: "transport", amount: 7_200 }, { kind: "other", amount: -30_050 }]),
    S("s-2", FL, 0, [{ kind: "fl_pay", amount: 1_200_000 }, { kind: "fl_pay", amount: 300_000 }, { kind: "ot", amount: 12_345 }, { kind: "merit", amount: 100_000 }, { kind: "commission", amount: 50_000 }], { status: "confirmed" }),
    S("s-3", PT, 1_000_000, []),
  ];
  test("🔑 every row's totalSatang equals that slip's own total, and base + other income = total", async () => {
    const { deps } = payDeps(SLIPS);
    const rep = await buildPayReport(PID, deps);
    for (const r of rep.rows) {
      const slip = await deps.getSlip(SLIPS.find((s) => s.teacherId === r.teacherId)!.id);
      expect(r.totalSatang).toBe(slip.total);
      expect(r.baseSatang + r.otherIncomeSatang).toBe(r.totalSatang);
    }
    expect(rep.rows.find((r) => r.teacherId === FT)!.totalSatang).toBe(2_500_000 + 70_000 + 35_000 + 5_000 + 7_200 - 30_050);
  });
  test("each kind lands in its own column, same-kind lines add up, a negative Other ± subtracts", async () => {
    const rep = await buildPayReport(PID, payDeps(SLIPS).deps);
    expect(rep.rows.find((r) => r.teacherId === FT)!.byKind).toEqual({ fl_pay: 0, extra_hour: 105_000, ot: 0, merit: 0, bonus: 5_000, commission: 0, transport: 7_200, other: -30_050 });
    expect(rep.rows.find((r) => r.teacherId === FL)!.byKind).toEqual({ fl_pay: 1_500_000, extra_hour: 0, ot: 12_345, merit: 100_000, bonus: 0, commission: 50_000, transport: 0, other: 0 });
    expect(rep.rows.find((r) => r.teacherId === PT)!.byKind).toEqual({ fl_pay: 0, extra_hour: 0, ot: 0, merit: 0, bonus: 0, commission: 0, transport: 0, other: 0 });
  });
  test("'other income' is every kind except base; the slip status and the base ride on the row", async () => {
    const rep = await buildPayReport(PID, payDeps(SLIPS).deps);
    const fl = rep.rows.find((r) => r.teacherId === FL)!;
    expect([fl.slipStatus, fl.baseSatang, fl.otherIncomeSatang]).toEqual(["confirmed", 0, 1_500_000 + 12_345 + 100_000 + 50_000]);
    expect(rep.rows.find((r) => r.teacherId === PT)!.slipStatus).toBe("draft");
  });
  test("🔑 totals = the column sums, and Σ rows total = totals.totalSatang", async () => {
    const rep = await buildPayReport(PID, payDeps(SLIPS).deps);
    expect(rep.totals.baseSatang).toBe(rep.rows.reduce((n, r) => n + r.baseSatang, 0));
    for (const k of PAY_KINDS) expect(rep.totals.byKind[k]).toBe(rep.rows.reduce((n, r) => n + r.byKind[k], 0));
    expect(rep.totals.otherIncomeSatang).toBe(rep.rows.reduce((n, r) => n + r.otherIncomeSatang, 0));
    expect(rep.totals.totalSatang).toBe(rep.rows.reduce((n, r) => n + r.totalSatang, 0));
    expect(rep.totals.baseSatang + rep.totals.otherIncomeSatang).toBe(rep.totals.totalSatang);
  });
  test("a kind this report has no column for, and a stray 'base' line, count under other: the row still adds up (never dropped)", async () => {
    const rep = await buildPayReport(PID, payDeps([S("s-9", FT, 100_000, [{ kind: "mystery", amount: 5_000 }, { kind: "base", amount: 700 }])]).deps);
    expect(rep.rows[0]!.byKind.other).toBe(5_700);
    expect(rep.rows[0]!.totalSatang).toBe(105_700);
  });
  test("🔑 a row that does not add up to its slip is an ERROR, never a quiet wrong number", async () => {
    const e = await buildPayReport(PID, payDeps([S("s-1", FT, 100, [{ kind: "bonus", amount: 50 }], { totalOverride: 999 })]).deps).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain("does not add up");
  });
  test("every slip of the period is read (one getSlip each), the missing-rates scan is off, rows are ordered by teacherId", async () => {
    const { deps, reads } = payDeps(SLIPS);
    const rep = await buildPayReport(PID, deps);
    expect(reads.getSlip.sort()).toEqual(["s-1", "s-2", "s-3"]);
    expect(reads.getPeriod).toEqual([[PID, { missingRates: false }]]);
    expect(rep.rows.map((r) => r.teacherId)).toEqual([FT, PT, FL]);
  });
  test("the JSON carries teacherId only, not the name the slips came with; integers only", async () => {
    const rep = await buildPayReport(PID, payDeps([S("s-1", FT, 100_000, [{ kind: "bonus", amount: 5_000 }], { teacherName: "Pim Secret" })]).deps);
    expect(JSON.stringify(rep)).not.toContain("Pim Secret");
    expect(Object.keys(rep.rows[0]!).sort()).toEqual(["baseSatang", "byKind", "otherIncomeSatang", "slipStatus", "teacherId", "totalSatang"]);
    for (const v of [rep.rows[0]!.baseSatang, rep.rows[0]!.totalSatang, ...Object.values(rep.rows[0]!.byKind)]) expect(Number.isInteger(v)).toBe(true);
  });
  test("an unknown period is 404; a period with no slips is a valid empty report", async () => {
    const e: any = await buildPayReport(PID, { getPeriod: async () => Promise.reject(notFound("x")), getSlip: async () => ({ baseAmount: 0, total: 0, lines: [] }) }).catch((x) => x);
    expect(e.status).toBe(404);
    const empty = await buildPayReport(PID, payDeps([]).deps);
    expect(empty.rows).toEqual([]);
    expect(empty.totals.totalSatang).toBe(0);
  });
  test("🔑 on the REAL salary service (in-memory store): the report's totals equal getSlip's, line by line", async () => {
    const store = memorySalaryStore();
    store.names.set(FT, "Pim");
    const svc = createSalaryService(store, () => new Date("2026-08-20T03:00:00Z"), { readHours: async () => [] });
    await svc.setProfile(FT, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    const period = await svc.createPeriod(2026, 10);
    await svc.runPeriod(period.id);
    const slip = (await svc.getPeriod(period.id)).slips[0]!;
    await svc.addLine(slip.id, { amount: 150_000, label: "ค่าสอนพิเศษ" }, "u");
    await svc.addLine(slip.id, { amount: -30_050, label: "หักมาสาย" }, "u");
    const rep = await buildPayReport(period.id, svc);
    expect(rep.rows[0]!.totalSatang).toBe((await svc.getSlip(slip.id)).total);
    expect(rep.rows[0]!.totalSatang).toBe(2_500_000 + 150_000 - 30_050);
    expect(rep.rows[0]!.byKind.other).toBe(119_950);
  });
});

// ───────────────────────────────── (C) Excel ─────────────────────────────────
async function sheetOf(bytes: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb.worksheets[0]!;
}
const cells = (ws: ExcelJS.Worksheet, rowNo: number) => (ws.getRow(rowNo).values as unknown[]).slice(1);

describe("(C) Excel — parses back with the same numbers", () => {
  const rep: TeachingReport = {
    period: { id: PID, year: 2026, month: 10, periodStart: "2026-09-30", periodEnd: "2026-10-30", status: "open", label: "30/09/26–30/10/26" },
    rows: [
      { teacherId: FT, role: "Full-time", minutesByClass: { private: 125, duo: 60, group: 0, eca: 180, camp: 0 }, weekdayMinutes: 245, weekendMinutes: 120, totalMinutes: 365, sessions: 5 },
      { teacherId: FL, role: "Freelance", minutesByClass: { private: 90, duo: 0, group: 45, eca: 0, camp: 0 }, weekdayMinutes: 135, weekendMinutes: 0, totalMinutes: 135, sessions: 3 },
    ],
    totals: { minutesByClass: { private: 215, duo: 60, group: 45, eca: 180, camp: 0 }, weekdayMinutes: 380, weekendMinutes: 120, totalMinutes: 500, sessions: 8 },
  };
  test("teaching: the header, one row per coach, the totals; hours are minutes ÷ 60 to 2 decimals", async () => {
    const ws = await sheetOf(await teachingToXlsx(rep, new Map([[FT, "Pim"], [FL, "Ton"]])));
    expect(ws.name).toBe("Teaching Summary");
    expect(cells(ws, 1)).toEqual(["Teaching Summary", "30/09/26–30/10/26"]);
    expect(cells(ws, 3)).toEqual(["Coach", "Role", "Private (h)", "Duo (h)", "Group (h)", "ECA (h)", "Camp (h)", "Weekday (h)", "Weekend (h)", "Total (h)", "Sessions"]);
    expect(cells(ws, 4)).toEqual(["Pim", "Full-time", 2.08, 1, 0, 3, 0, 4.08, 2, 6.08, 5]);
    expect(cells(ws, 5)).toEqual(["Ton", "Freelance", 1.5, 0, 0.75, 0, 0, 2.25, 0, 2.25, 3]);
    expect(cells(ws, 6)).toEqual(["Total", "", 3.58, 1, 0.75, 3, 0, 6.33, 2, 8.33, 8]);
    expect(hoursOf(125)).toBe(2.08);
    expect(hoursOf(130)).toBe(2.17); // rounded, not floored (2.1666…)
    expect(hoursOf(90)).toBe(1.5);
  });
  test("teaching: a coach with no known name shows the id (as the slip export does)", async () => {
    expect(cells(await sheetOf(await teachingToXlsx(rep, new Map())), 4)[0]).toBe(FT);
  });
  test("🔑 formulaSafe is applied to the NAME cells: a name that starts with = + - @ is stored as text with a leading apostrophe", async () => {
    const wsT = await sheetOf(await teachingToXlsx(rep, new Map([[FT, '=HYPERLINK("http://x")'], [FL, "+cmd"]])));
    expect(cells(wsT, 4)[0]).toBe("'=HYPERLINK(\"http://x\")");
    expect(cells(wsT, 5)[0]).toBe("'+cmd");
    const pay = await buildPayReport(PID, payDeps([S("s-1", FT, 100, [])]).deps);
    expect(cells(await sheetOf(await payToXlsx(pay, new Map([[FT, "@SUM(1)"]]))), 4)[0]).toBe("'@SUM(1)");
    expect(cells(await sheetOf(await payToXlsx(pay, new Map([[FT, "Pim"]]))), 4)[0]).toBe("Pim");
  });
  test("pay: the section words as columns, baht = satang ÷ 100 as real numbers (not text), 'Other income' and 'Total' last, the totals row", async () => {
    const pay: PayReport = await buildPayReport(PID, payDeps([
      S("s-1", FT, 2_500_000, [{ kind: "extra_hour", amount: 105_000 }, { kind: "bonus", amount: 5_000 }, { kind: "other", amount: -30_050 }]),
      S("s-2", FL, 0, [{ kind: "fl_pay", amount: 1_500_000 }, { kind: "merit", amount: 100_001 }], { status: "confirmed" }),
    ]).deps);
    const ws = await sheetOf(await payToXlsx(pay, new Map([[FT, "Pim"], [FL, "Ton"]])));
    expect(ws.name).toBe("Salary Report");
    expect(cells(ws, 3)).toEqual(["Person", "Status", "Base Salary (฿)", "Freelance Teaching Pay (฿)", "Extra Hour (฿)", "OT (฿)", "Merit (฿)", "Bonus (฿)", "Commission (฿)", "Transportation (฿)", "Other ± (฿)", "Other income (฿)", "Total (฿)"]);
    expect(cells(ws, 4)).toEqual(["Pim", "draft", 25_000, 0, 1_050, 0, 0, 50, 0, 0, -300.5, 799.5, 25_799.5]);
    expect(cells(ws, 5)).toEqual(["Ton", "confirmed", 0, 15_000, 0, 0, 1_000.01, 0, 0, 0, 0, 16_000.01, 16_000.01]);
    expect(cells(ws, 6)).toEqual(["Total", "", 25_000, 15_000, 1_050, 0, 1_000.01, 50, 0, 0, -300.5, 16_799.51, 41_799.51]);
    for (const col of [3, 4, 13]) expect(typeof ws.getRow(4).getCell(col).value).toBe("number");
    expect(ws.getRow(4).getCell(13).numFmt).toBe("#,##0.00;-#,##0.00");
  });
  test("🔑 the Excel's numbers equal the JSON's: every pay row's total cell × 100 is the row's totalSatang", async () => {
    const pay = await buildPayReport(PID, payDeps([S("s-1", FT, 2_500_000, [{ kind: "bonus", amount: 5_000 }]), S("s-2", PT, 1_000_001, [{ kind: "transport", amount: 7_200 }])]).deps);
    const ws = await sheetOf(await payToXlsx(pay, new Map()));
    pay.rows.forEach((r, i) => expect(Math.round(Number(cells(ws, 4 + i)[12]) * 100)).toBe(r.totalSatang));
    expect(Math.round(Number(cells(ws, 4 + pay.rows.length)[12]) * 100)).toBe(pay.totals.totalSatang);
  });
  test("the response: the xlsx mime, an attachment named salary-<kind>-<YYYY-MM>.xlsx, never cached", async () => {
    const { deps } = teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: [h("2026-10-14", 9, 1)] } });
    const res = await teachingXlsxFor(PID, deps);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="salary-teaching-2026-10.xlsx"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(cells(await sheetOf(new Uint8Array(await res.arrayBuffer())), 4)[0]).toBe("Name 11");
    expect((await payXlsxFor(PID, payDeps([S("s-1", FT, 1, [])]).deps)).headers.get("content-disposition")).toBe('attachment; filename="salary-pay-2026-10.xlsx"');
    expect(reportFilename("pay", { year: 2026, month: 1 })).toBe("salary-pay-2026-01.xlsx");
  });
  test("the teaching Excel takes names from the people list; the pay Excel from the names the slips carry", async () => {
    const t = teachingDeps({ profiles: [prof(FT, "FT")], rows: { [FT]: [h("2026-10-14", 9, 1)] } });
    t.deps.listEntriesPeople = async () => [{ teacherId: FT, name: "Pim" }];
    expect(cells(await sheetOf(new Uint8Array(await (await teachingXlsxFor(PID, t.deps)).arrayBuffer())), 4)[0]).toBe("Pim");
    expect(cells(await sheetOf(new Uint8Array(await (await payXlsxFor(PID, payDeps([S("s-1", FT, 1, [], { teacherName: "Pim" })]).deps)).arrayBuffer())), 4)[0]).toBe("Pim");
  });
});

// ───────────────────────────────── the routes (the CEO-only gate) ─────────────────────────────────
describe("the /salary/reports routes", () => {
  const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.JWT_SECRET = "test-secret-922";
    process.env.SKIP_ADMIN_AUTH = "false";
  });
  afterAll(() => {
    for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  });
  const spies: ReturnType<typeof spyOn>[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  async function setup() {
    const store = memorySalaryStore();
    store.names.set(FT, "Pim");
    const svc = createSalaryService(store, () => new Date("2026-08-20T03:00:00Z"), { readHours: async () => [] });
    await svc.setProfile(FT, { employmentType: "FT", baseSalary: 2_500_000, active: true });
    const period = await svc.createPeriod(2026, 10);
    await svc.runPeriod(period.id);
    spies.push(spyOn(hoursReader, "collectRows").mockImplementation((async () => [h("2026-10-14", 9, 2), h("2026-10-17", 9, 1)]) as never));
    const app = new Hono();
    app.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "INTERNAL", message: String(err) } }, 500)));
    app.route("/salary", makeSalaryRoutes(svc));
    return { app, period, svc };
  }
  const tok = async (role: Role) => ({ Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` });
  const get = async (app: Hono, path: string, role: Role | null = "ceo") => app.request(`/salary${path}`, { headers: role ? await tok(role) : {} });
  const PATHS = ["/reports/teaching", "/reports/pay", "/reports/teaching.xlsx", "/reports/pay.xlsx"];

  test("🔑 an ADMIN and a COACH are 403, no token 401 — on all four routes (the pay figures are the CEO's)", async () => {
    const { app, period } = await setup();
    for (const p of PATHS) {
      expect((await get(app, `${p}?periodId=${period.id}`, "admin")).status).toBe(403);
      expect((await get(app, `${p}?periodId=${period.id}`, "coach")).status).toBe(403);
      expect((await get(app, `${p}?periodId=${period.id}`, null)).status).toBe(401);
    }
  });
  test("the CEO gets 200 JSON on both reports, with the expected shapes", async () => {
    const { app, period } = await setup();
    const t: any = await (await get(app, `/reports/teaching?periodId=${period.id}`)).json();
    expect(t.rows).toHaveLength(1);
    expect([t.rows[0].teacherId, t.rows[0].role, t.rows[0].minutesByClass.private, t.rows[0].weekendMinutes, t.rows[0].sessions]).toEqual([FT, "Full-time", 180, 60, 2]);
    const p: any = await (await get(app, `/reports/pay?periodId=${period.id}`)).json();
    expect([p.rows[0].teacherId, p.rows[0].baseSatang, p.rows[0].totalSatang, p.totals.totalSatang]).toEqual([FT, 2_500_000, 2_500_000, 2_500_000]);
  });
  test("both Excel routes answer the xlsx mime with a parseable workbook (names from the real service)", async () => {
    const { app, period } = await setup();
    for (const p of ["/reports/teaching.xlsx", "/reports/pay.xlsx"]) {
      const res = await get(app, `${p}?periodId=${period.id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(cells(await sheetOf(new Uint8Array(await res.arrayBuffer())), 4)[0]).toBe("Pim");
    }
  });
  test("periodId: missing → 400, malformed → 404, unknown → 404 (never a database error)", async () => {
    const { app } = await setup();
    for (const p of PATHS) {
      expect((await get(app, p)).status).toBe(400);
      expect((await get(app, `${p}?periodId=not-a-uuid`)).status).toBe(404);
      expect((await get(app, `${p}?periodId=00000000-0000-4000-8000-0000000000aa`)).status).toBe(404);
    }
  });
  test("periodIdOf: required, then the route's own uuid rule", () => {
    const uuid = (v: string | undefined, what: string) => { if (!v || v.length !== 36) throw notFound(what); return v; };
    expect(() => periodIdOf(undefined, uuid)).toThrow("periodId is required");
    expect(() => periodIdOf("", uuid)).toThrow("periodId is required");
    expect(() => periodIdOf("short", uuid)).toThrow();
    expect(periodIdOf(PID, uuid)).toBe(PID);
  });
  test("read-only by source: the service has no insert / update / delete / transaction, and the routes are four CEO-gated GETs", async () => {
    const src = (await Bun.file(new URL("./salary-reports.service.ts", import.meta.url)).text()).replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.execute\(|\.transaction\(|addLine|runPeriod|lockPeriod/);
    const routes = (await Bun.file(new URL("../routes/salary.ts", import.meta.url)).text()).replace(/\r\n/g, "\n");
    const mine = routes.split("\n").filter((l) => l.includes('.get("/reports/'));
    expect(mine).toHaveLength(4);
    for (const l of mine) expect(l).toContain("ceo,");
  });
});
