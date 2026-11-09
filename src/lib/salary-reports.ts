// TASK-922 (REQ-120 R1.8) — the month-end SALARY reports, PURE: (A) each coach's teaching summary, (B) everyone's salary + other income. No database, no I/O.
//   • (A) is built from TASK-872's `HoursDay[]` (the SAME minutes the pay run and TASK-885 read), plus the number of classes; NO money;
//   • (B) is built from the slips the salary service already serves (`getSlip`): the row's total IS the slip's total (base + every line), and the byKind columns add up to it;
//   • integer minutes / integer satang everywhere; hours = minutes / 60 with 2 decimals (display only).
import { isWeekend, type EmploymentType } from "./role-of-day";

export const CLASS_KEYS = ["private", "duo", "group", "eca", "camp"] as const;
export type ClassKey = (typeof CLASS_KEYS)[number];
export type MinutesByClass = Record<ClassKey, number>;
export const zeroByClass = (): MinutesByClass => ({ private: 0, duo: 0, group: 0, eca: 0, camp: 0 });

/** 885's words for a role (`DAILY_ROLE_WORDS`). */
export const ROLE_WORDS: Record<"FT" | "PT" | "FL", string> = { FT: "Full-time", PT: "Part-time", FL: "Freelance" };
const ROLE_ORDER: ReadonlyArray<"FT" | "PT" | "FL"> = ["FT", "PT", "FL"];

/** The person's role(s) as words: «Full-time», «Part-time», «Freelance», or «Part-time + Freelance» (the only two-role combination). */
export const rolesToWords = (roles: readonly EmploymentType[]): string => ROLE_ORDER.filter((r) => roles.includes(r)).map((r) => ROLE_WORDS[r]).join(" + ");
/** Sort rank: FT, then PT, then FL (a PT + FL person sorts as PT). */
export const roleRank = (roles: readonly EmploymentType[]): number => {
  const i = ROLE_ORDER.findIndex((r) => roles.includes(r));
  return i < 0 ? ROLE_ORDER.length : i;
};

export interface TeachingRow {
  teacherId: string;
  role: string;
  minutesByClass: MinutesByClass;
  weekdayMinutes: number;
  weekendMinutes: number;
  totalMinutes: number;
  sessions: number;
}
export interface TeachingTotals { minutesByClass: MinutesByClass; weekdayMinutes: number; weekendMinutes: number; totalMinutes: number; sessions: number }

/** The slice of a `HoursDay` this reads. */
export interface DayMinutes { date: string; byType: Record<ClassKey, number>; teachingMinutesTotal: number }

/** One coach's row from their days; `null` when they taught nothing in the period (no row). Weekend = Saturday / Sunday of the Bangkok date. */
export function teachingRow(teacherId: string, roles: readonly EmploymentType[], days: readonly DayMinutes[], sessions: number): TeachingRow | null {
  const minutesByClass = zeroByClass();
  let weekday = 0;
  let weekend = 0;
  for (const d of days) {
    for (const t of CLASS_KEYS) minutesByClass[t] += d.byType[t];
    if (isWeekend(d.date)) weekend += d.teachingMinutesTotal;
    else weekday += d.teachingMinutesTotal;
  }
  const totalMinutes = CLASS_KEYS.reduce((n, t) => n + minutesByClass[t], 0);
  if (totalMinutes <= 0) return null;
  return { teacherId, role: rolesToWords(roles), minutesByClass, weekdayMinutes: weekday, weekendMinutes: weekend, totalMinutes, sessions };
}

export function teachingTotals(rows: readonly TeachingRow[]): TeachingTotals {
  const t: TeachingTotals = { minutesByClass: zeroByClass(), weekdayMinutes: 0, weekendMinutes: 0, totalMinutes: 0, sessions: 0 };
  for (const r of rows) {
    for (const c of CLASS_KEYS) t.minutesByClass[c] += r.minutesByClass[c];
    t.weekdayMinutes += r.weekdayMinutes;
    t.weekendMinutes += r.weekendMinutes;
    t.totalMinutes += r.totalMinutes;
    t.sessions += r.sessions;
  }
  return t;
}

/** Hours with 2 decimals from whole minutes: 90 → 1.5, 125 → 2.08. */
export const hours2 = (minutes: number): number => Math.round((minutes * 100) / 60) / 100;

// ───────────────────────────── (B) pay ─────────────────────────────

export const PAY_KINDS = ["fl_pay", "extra_hour", "ot", "merit", "bonus", "commission", "transport", "other"] as const;
export type PayKind = (typeof PAY_KINDS)[number];
export type PayByKind = Record<PayKind, number>;
export const zeroByKind = (): PayByKind => ({ fl_pay: 0, extra_hour: 0, ot: 0, merit: 0, bonus: 0, commission: 0, transport: 0, other: 0 });

export type SlipStatus = "draft" | "confirmed" | "locked";
export interface PayRow { teacherId: string; slipStatus: SlipStatus; baseSatang: number; byKind: PayByKind; otherIncomeSatang: number; totalSatang: number }
export interface PayTotals { baseSatang: number; byKind: PayByKind; otherIncomeSatang: number; totalSatang: number }

/**
 * One slip → one row. «Other income» = every kind except base (R1.8's words). `totalSatang` is the SLIP's own total. A line of a kind this report has no column for (and a stray «base» line) goes under
 * `other` — never dropped — so base + Σ byKind = total; if it does NOT, the row is an ERROR (a quiet wrong number is worse than none).
 */
export function payRow(teacherId: string, slipStatus: SlipStatus, slip: { baseAmount: number; total: number; lines: { kind: string; amount: number }[] }, slipId = ""): PayRow {
  const byKind = zeroByKind();
  for (const l of slip.lines) byKind[(PAY_KINDS as readonly string[]).includes(l.kind) ? (l.kind as PayKind) : "other"] += l.amount;
  const otherIncomeSatang = PAY_KINDS.reduce((n, k) => n + byKind[k], 0);
  if (slip.baseAmount + otherIncomeSatang !== slip.total) throw new Error(`salary report: slip ${slipId || teacherId} does not add up (base ${slip.baseAmount} + lines ${otherIncomeSatang} ≠ total ${slip.total})`);
  return { teacherId, slipStatus, baseSatang: slip.baseAmount, byKind, otherIncomeSatang, totalSatang: slip.total };
}

export function payTotals(rows: readonly PayRow[]): PayTotals {
  const t: PayTotals = { baseSatang: 0, byKind: zeroByKind(), otherIncomeSatang: 0, totalSatang: 0 };
  for (const r of rows) {
    t.baseSatang += r.baseSatang;
    for (const k of PAY_KINDS) t.byKind[k] += r.byKind[k];
    t.otherIncomeSatang += r.otherIncomeSatang;
    t.totalSatang += r.totalSatang;
  }
  return t;
}
