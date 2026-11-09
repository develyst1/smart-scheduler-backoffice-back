// The money-grade pay rules (SPEC-101 §6 / TASK-878 / REQ-120 R1.2–R1.3, R1.6). PURE: no database, no clock, no float money.
// Everything is integer SATANG; minutes come from link 2's reader (integer minutes per Bangkok date per class type).
// Each rule rounds ONCE, at the line (half up), from an integer numerator — never from a float.

import { roleOfDay, isWeekend, type HasRoles } from "./role-of-day";
import { numericFromSatang } from "./satang";

export type ClassType = "private" | "duo" | "group" | "eca" | "camp";
export const CLASS_ORDER: readonly ClassType[] = ["private", "duo", "group", "eca", "camp"];

/** One day of the reader's output (the contract: integer minutes). */
export interface HoursDay {
  date: string;
  byType: Record<ClassType, number>;
  teachingMinutesTotal: number;
}

/** Extra Hour: 350 ฿ per hour, per DAY, from the 5th teaching hour on a weekday / the 6th on a weekend (REQ-120 R1.2). */
export const EXTRA_HOUR_RATE_SATANG = 35_000;
export const EXTRA_THRESHOLD_MIN_WEEKDAY = 240; // the first 4 hours are not extra; hour 5 onward is
export const EXTRA_THRESHOLD_MIN_WEEKEND = 300; // the first 5 hours are not extra; hour 6 onward is

/** num / den, rounded half up, for non-negative integers. */
export function roundDiv(num: number, den: number): number {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0 || num < 0) throw new Error(`roundDiv(${num}, ${den})`);
  return Math.floor((2 * num + den) / (2 * den));
}

/** Satang owed for `minutes` of work at `ratePerHourSatang`: minutes ÷ 60 × rate, rounded once. */
export const payForMinutes = (minutes: number, ratePerHourSatang: number): number => roundDiv(minutes * ratePerHourSatang, 60);

/** OT (R1.2): base ÷ 26 ÷ 8 × 1.15 per hour × the hours an admin entered. Satang for `minutes` of OT on a monthly `baseSatang`. */
export const otPaySatang = (baseSatang: number, minutes: number): number => {
  if (!Number.isSafeInteger(baseSatang) || baseSatang < 0 || !Number.isSafeInteger(minutes) || minutes < 0) throw new Error("otPaySatang: non-negative integers only");
  // base × 1.15 ÷ 26 ÷ 8 × (minutes ÷ 60)  =  base × 115 × minutes ÷ (26 × 8 × 100 × 60)  — BigInt so no product can lose precision.
  const num = BigInt(baseSatang) * 115n * BigInt(minutes);
  const den = 26n * 8n * 100n * 60n;
  return Number((2n * num + den) / (2n * den));
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (date: string): string => DOW[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
/** `2026-10-14` → `14/10` (the customer's own display, R1.6: "14/10 = 6 Hr"). */
export const ddmm = (date: string): string => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
/** minutes → "1.5", "2", "0.25": hours for a LABEL (display only; no money flows through it). */
const hours = (min: number): string => String(Math.round((min / 60) * 100) / 100);
const baht = (satang: number): string => numericFromSatang(satang).replace(/\.00$/, "");

export interface AutoLine {
  kind: "fl_pay" | "extra_hour";
  /** What this line was derived from — the idempotency key (migration 0011's partial unique index). */
  sourceRef: string;
  label: string;
  amountSatang: number;
  /** 🔻 TASK-903 - set on `fl_pay` lines only (one line per date x class type); absent for every other kind. */
  classType?: ClassType;
  /** 🔻 TASK-920: set on `extra_hour` lines (that day's extra minutes), so a notification can say "2 Hr" without parsing the label (which carries the rate). */
  extraMinutes?: number;
}

/**
 * FL teaching pay ("Freelance Hour" on the slip): for every day whose role is FL, Σ over class types of minutes ÷ 60 × the person's
 * rate for that type, rounded once per DATE. A day's class type with minutes but NO rate is a problem the CEO must see — it is returned
 * in `missingRates` instead of being paid at 0 silently. One line per date, itemised with the class breakdown (R1.6).
 */
export function flPayLines(profile: HasRoles, ratesSatang: Partial<Record<ClassType, number>>, days: readonly HoursDay[]): { lines: AutoLine[]; missingRates: { date: string; classType: ClassType }[] } {
  const lines: AutoLine[] = [];
  const missingRates: { date: string; classType: ClassType }[] = [];
  // 🔻 TASK-903 - ONE line per (FL date x class type), each rounded once at its own line, so the slip / export can group by class type.
  for (const d of days) {
    if (roleOfDay(profile, d.date) !== "FL") continue;
    for (const c of CLASS_ORDER) {
      const min = d.byType[c] ?? 0;
      if (min <= 0) continue;
      const rate = ratesSatang[c];
      if (rate === undefined) {
        missingRates.push({ date: d.date, classType: c });
        continue;
      }
      const amount = payForMinutes(min, rate);
      if (amount === 0) continue; // a 0-rate class earns nothing: no line
      lines.push({ kind: "fl_pay", classType: c, sourceRef: `fl:${d.date}:${c}`, label: `${ddmm(d.date)} (${dow(d.date)}): ${c} ${hours(min)} Hr × ${baht(rate)}`, amountSatang: amount });
    }
  }
  return { lines, missingRates };
}

/**
 * Extra Hour, 350 ฿/hr (FT · PT): per DAY, the teaching minutes (incl. ECA/camp) beyond the threshold — 240 min on a weekday, 300 on a
 * weekend. A PT person earns it only on PT days (`roleOfDay === 'PT'`); an FT person on every day; FL / STAFF never.
 * One line per date: "14/10 (Wed): 6 Hr → extra 2 Hr × 350".
 */
export function extraHourLines(profile: HasRoles, days: readonly HoursDay[]): AutoLine[] {
  const lines: AutoLine[] = [];
  for (const d of days) {
    const role = roleOfDay(profile, d.date);
    if (role !== "FT" && role !== "PT") continue;
    const threshold = isWeekend(d.date) ? EXTRA_THRESHOLD_MIN_WEEKEND : EXTRA_THRESHOLD_MIN_WEEKDAY;
    const extra = Math.max(0, d.teachingMinutesTotal - threshold);
    if (extra === 0) continue;
    lines.push({
      kind: "extra_hour",
      sourceRef: `eh:${d.date}`,
      label: `${ddmm(d.date)} (${dow(d.date)}): ${hours(d.teachingMinutesTotal)} Hr → extra ${hours(extra)} Hr × ${baht(EXTRA_HOUR_RATE_SATANG)}`,
      amountSatang: payForMinutes(extra, EXTRA_HOUR_RATE_SATANG),
      extraMinutes: extra,
    });
  }
  return lines;
}
