// TASK-922 (REQ-120 R1.8) — the month-end SALARY reports (read-only, CEO only): (A) every coach's teaching summary, (B) everyone's salary + other income, and an Excel of each.
//
//   • (A) reads through TASK-872's `readHours` — the SAME source as the pay run and TASK-885 — for the R1.4 period range; the class COUNT comes from the very rows that call collected (counted exactly as
//     `bucketMinutes` counts them), so minutes and sessions cannot disagree. «No Teacher» is never a row (the people list drops the system teacher), and there is NO money in (A);
//   • (B) reads each slip through the salary service's own `getSlip` (so a row's total IS the slip's total) and splits its lines by kind; a row that does not add up is an error;
//   • the JSON carries `teacherId` only (names are the front's join, SPEC-100 §9b); the Excel puts names in through `formulaSafe` (TASK-879's guard).
// The routes pass the SALARY SERVICE as `deps` (it already has getPeriod / getSlip / listProfiles / listEntriesPeople); only the timetable collector is the reader's own.
import ExcelJS from "exceljs";
import { badRequest } from "../lib/http";
import { payPeriodRange } from "../lib/pay-period";
import { effectiveRoles, type EmploymentType } from "../lib/role-of-day";
import { CLASS_KEYS, PAY_KINDS, hours2, payRow, payTotals, roleRank, rolesToWords, teachingRow, teachingTotals, type PayRow, type PayTotals, type SlipStatus, type TeachingRow, type TeachingTotals } from "../lib/salary-reports";
import { SECTION_OF_KIND, formulaSafe, periodLabel } from "../lib/slip-sections";
import * as hoursReader from "./hours-reader";

export { PAY_KINDS };
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface ReportPeriod { id: string; year: number; month: number; periodStart: string; periodEnd: string; status: string; label: string }
export interface TeachingReport { period: ReportPeriod; rows: TeachingRow[]; totals: TeachingTotals }
export interface PayReport { period: ReportPeriod; rows: PayRow[]; totals: PayTotals }

/** The slice of the salary service (and its fakes) the reports read. */
export interface ReportDeps {
  getPeriod(id: string, opts?: { missingRates?: boolean }): Promise<{
    period: { id: string; year: number; month: number; periodStart: string | null; periodEnd: string | null; status: string };
    slips: Array<{ id: string; teacherId: string; teacherName?: string | null; status: SlipStatus }>;
  }>;
  getSlip(id: string): Promise<{ baseAmount: number; total: number; lines: Array<{ kind: string; amount: number }> }>;
  listProfiles(): Promise<Array<{ teacherId: string; employmentType: EmploymentType; roles: readonly EmploymentType[]; active: boolean }>>;
  /** The people the app may name (the system teacher already left out). */
  listEntriesPeople(): Promise<Array<{ teacherId: string; name?: string }>>;
  /** The timetable rows of one coach for `[start, end]` — `hoursReader.collectRows` unless a test swaps it. */
  collectRows?(teacherId: string, start: string, end: string): Promise<hoursReader.TimetableRow[]>;
}

export const hoursOf = hours2;
export const roleWords = (p: { employmentType: EmploymentType; roles?: readonly EmploymentType[] }): string => rolesToWords(effectiveRoles(p));
export const reportFilename = (kind: "teaching" | "pay", p: { year: number; month: number }): string => `salary-${kind}-${p.year}-${String(p.month).padStart(2, "0")}.xlsx`;

/** The `periodId` query value: required (400), then the router's own uuid rule (a malformed id is «not found», never a database error). */
export function periodIdOf(raw: string | undefined, uuid: (v: string | undefined, what: string) => string): string {
  if (!raw) throw badRequest("periodId is required");
  return uuid(raw, "Pay period not found");
}

function reportPeriod(p: { id: string; year: number; month: number; periodStart: string | null; periodEnd: string | null; status: string }): ReportPeriod {
  const range = p.periodStart && p.periodEnd ? { start: p.periodStart, end: p.periodEnd } : payPeriodRange(p.year, p.month); // a period made before TASK-871 has no stored range: the computed R1.4 one
  return { id: p.id, year: p.year, month: p.month, periodStart: range.start, periodEnd: range.end, status: p.status, label: periodLabel({ year: p.year, month: p.month, periodStart: range.start, periodEnd: range.end }) };
}

/** How many CLASSES a coach taught: the rows `readHours` counted (same range filter, same `classifyRow`, same live-group rule as `bucketMinutes`). */
export function countSessions(rows: readonly hoursReader.TimetableRow[], start: string, end: string): number {
  const inRange = rows.filter((r) => r.date >= start && r.date <= end);
  const live = hoursReader.liveGroupIds(inRange);
  let n = 0;
  for (const r of inRange) if (!("skipped" in hoursReader.classifyRow(r, live))) n++;
  return n;
}

// ───────────────────────────── (A) teaching ─────────────────────────────

async function teachingWithNames(periodId: string, deps: Pick<ReportDeps, "getPeriod" | "listProfiles" | "listEntriesPeople" | "collectRows">): Promise<{ report: TeachingReport; names: Map<string, string> }> {
  const { period: p } = await deps.getPeriod(periodId, { missingRates: false }); // 404 if unknown; skips the (heavy, unrelated) missing-rate scan
  const period = reportPeriod(p);
  const [profiles, people] = await Promise.all([deps.listProfiles(), deps.listEntriesPeople()]);
  const real = new Set(people.map((x) => x.teacherId));
  const names = new Map(people.flatMap((x) => (x.name ? [[x.teacherId, x.name] as [string, string]] : [])));
  const collect = deps.collectRows ?? ((t: string, a: string, b: string) => hoursReader.collectRows(t, a, b)); // looked up per call so a spy on the module is seen
  const rows: Array<TeachingRow & { _rank: number }> = [];
  for (const prof of profiles.filter((x) => x.active && real.has(x.teacherId) && effectiveRoles(x).some((r) => r === "FT" || r === "PT" || r === "FL"))) {
    let kept: hoursReader.TimetableRow[] = [];
    const days = await hoursReader.readHours(prof.teacherId, period.periodStart, period.periodEnd, async (t, a, b) => (kept = await collect(t, a, b)));
    const row = teachingRow(prof.teacherId, effectiveRoles(prof), days, countSessions(kept, period.periodStart, period.periodEnd));
    if (row) rows.push({ ...row, _rank: roleRank(effectiveRoles(prof)) });
  }
  rows.sort((a, b) => a._rank - b._rank || (a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0));
  const out: TeachingRow[] = rows.map(({ _rank, ...r }) => r);
  return { report: { period, rows: out, totals: teachingTotals(out) }, names };
}
export const buildTeachingReport = async (periodId: string, deps: Pick<ReportDeps, "getPeriod" | "listProfiles" | "listEntriesPeople" | "collectRows">): Promise<TeachingReport> => (await teachingWithNames(periodId, deps)).report;

// ───────────────────────────── (B) pay ─────────────────────────────

async function payWithNames(periodId: string, deps: Pick<ReportDeps, "getPeriod" | "getSlip">): Promise<{ report: PayReport; names: Map<string, string> }> {
  const { period: p, slips } = await deps.getPeriod(periodId, { missingRates: false });
  const rows: PayRow[] = [];
  const names = new Map<string, string>();
  for (const s of [...slips].sort((a, b) => (a.teacherId < b.teacherId ? -1 : a.teacherId > b.teacherId ? 1 : 0))) {
    rows.push(payRow(s.teacherId, s.status, await deps.getSlip(s.id), s.id));
    if (s.teacherName) names.set(s.teacherId, s.teacherName);
  }
  return { report: { period: reportPeriod(p), rows, totals: payTotals(rows) }, names };
}
export const buildPayReport = async (periodId: string, deps: Pick<ReportDeps, "getPeriod" | "getSlip">): Promise<PayReport> => (await payWithNames(periodId, deps)).report;

// ───────────────────────────── (C) Excel ─────────────────────────────

const money = "#,##0.00;-#,##0.00";
const nameCell = (names: Map<string, string>, id: string) => formulaSafe(names.get(id) ?? id); // the id when the lookup finds none

export async function teachingToXlsx(r: TeachingReport, names: Map<string, string>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Teaching Summary");
  ws.columns = [{ width: 28 }, { width: 22 }, ...Array.from({ length: 9 }, () => ({ width: 13 }))];
  ws.addRow(["Teaching Summary", formulaSafe(r.period.label)]).font = { bold: true };
  ws.addRow([]);
  ws.addRow(["Coach", "Role", "Private (h)", "Duo (h)", "Group (h)", "ECA (h)", "Camp (h)", "Weekday (h)", "Weekend (h)", "Total (h)", "Sessions"]).font = { bold: true };
  const line = (label: string, role: string, x: { minutesByClass: Record<string, number>; weekdayMinutes: number; weekendMinutes: number; totalMinutes: number; sessions: number }) =>
    ws.addRow([label, role, ...CLASS_KEYS.map((c) => hours2(x.minutesByClass[c]!)), hours2(x.weekdayMinutes), hours2(x.weekendMinutes), hours2(x.totalMinutes), x.sessions]);
  for (const x of r.rows) line(nameCell(names, x.teacherId), formulaSafe(x.role), x);
  line("Total", "", r.totals).font = { bold: true };
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export async function payToXlsx(r: PayReport, names: Map<string, string>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Salary Report");
  ws.columns = [{ width: 28 }, { width: 12 }, ...Array.from({ length: 11 }, () => ({ width: 16 }))];
  ws.addRow(["Salary Report", formulaSafe(r.period.label)]).font = { bold: true };
  ws.addRow([]);
  const KIND_HEAD: Record<(typeof PAY_KINDS)[number], string> = { fl_pay: SECTION_OF_KIND.fl_pay ?? "Freelance Teaching Pay", extra_hour: "Extra Hour", ot: "OT", merit: "Merit", bonus: "Bonus", commission: "Commission", transport: "Transportation", other: "Other ±" };
  ws.addRow(["Person", "Status", "Base Salary (฿)", ...PAY_KINDS.map((k) => `${KIND_HEAD[k]} (฿)`), "Other income (฿)", "Total (฿)"]).font = { bold: true };
  const withFormat = (row: ExcelJS.Row) => { for (let c = 3; c <= 3 + PAY_KINDS.length + 2; c++) row.getCell(c).numFmt = money; return row; };
  for (const x of r.rows) withFormat(ws.addRow([nameCell(names, x.teacherId), x.slipStatus, x.baseSatang / 100, ...PAY_KINDS.map((k) => x.byKind[k] / 100), x.otherIncomeSatang / 100, x.totalSatang / 100]));
  const t = withFormat(ws.addRow(["Total", "", r.totals.baseSatang / 100, ...PAY_KINDS.map((k) => r.totals.byKind[k] / 100), r.totals.otherIncomeSatang / 100, r.totals.totalSatang / 100]));
  t.font = { bold: true };
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

const xlsxResponse = (bytes: Uint8Array, filename: string) =>
  new Response(bytes, { headers: { "Content-Type": XLSX_MIME, "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });

export async function teachingXlsxFor(periodId: string, deps: Pick<ReportDeps, "getPeriod" | "listProfiles" | "listEntriesPeople" | "collectRows">): Promise<Response> {
  const { report, names } = await teachingWithNames(periodId, deps);
  return xlsxResponse(await teachingToXlsx(report, names), reportFilename("teaching", report.period));
}
export async function payXlsxFor(periodId: string, deps: Pick<ReportDeps, "getPeriod" | "getSlip">): Promise<Response> {
  const { report, names } = await payWithNames(periodId, deps);
  return xlsxResponse(await payToXlsx(report, names), reportFilename("pay", report.period));
}
