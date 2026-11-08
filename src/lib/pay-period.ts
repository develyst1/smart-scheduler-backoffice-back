// R1.4 — the money-grade pay period (SPEC-101 §3 / TASK-871). NOT a calendar month:
// a period runs from the LAST DAY OF THE PREVIOUS MONTH to the DAY BEFORE THE LAST DAY OF THIS MONTH
// ("30/9–30/10" for October). Confirm day = the last day of the month, before 12:00 Bangkok (R1.5, unchanged).
// Dates are plain `YYYY-MM-DD` strings (Asia/Bangkok calendar dates); all arithmetic is on UTC midnight so no timezone can shift a day.

const iso = (y: number, m: number, d: number): string => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** Number of days in month `m` (1–12) of year `y`. */
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

export interface PayPeriodRange {
  /** Inclusive first day: the last day of the previous month. */
  start: string;
  /** Inclusive last day: the day before the last day of this month. */
  end: string;
}

/** `payPeriodRange(2026, 10)` → `{ start: "2026-09-30", end: "2026-10-30" }`. `month` is 1–12. */
export function payPeriodRange(year: number, month: number): PayPeriodRange {
  if (!Number.isInteger(year) || year < 1 || year > 9999) throw new Error(`year out of range: ${year}`);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error(`month must be 1–12: ${month}`);
  const prevY = month === 1 ? year - 1 : year;
  const prevM = month === 1 ? 12 : month - 1;
  return { start: iso(prevY, prevM, daysIn(prevY, prevM)), end: iso(year, month, daysIn(year, month) - 1) };
}
