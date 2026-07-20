// Month helpers for effective-dated recurring costs (SPEC-002). A "month" is "YYYY-MM";
// effective_from/to are stored/compared as first-day-of-month ISO dates "YYYY-MM-01".
// Pure — no Date/timezone calls, so the effective-dating logic is deterministic & unit-testable.

const MONTH_RE = /^\d{4}-\d{2}$/;

export function isMonth(s: string): boolean {
  return MONTH_RE.test(s);
}

/** "YYYY-MM" → "YYYY-MM-01" (first day of that month). */
export function monthFirstDay(month: string): string {
  return `${month}-01`;
}

/** First day of the month *before* `month`. "2026-01" → "2025-12-01". */
export function prevMonthFirstDay(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}-01`;
}

export interface EffectiveWindow {
  effectiveFrom: string; // "YYYY-MM-DD"
  effectiveTo: string | null; // "YYYY-MM-DD" or null (open-ended)
}

/** Does an effective-dated row cover `month`? ISO dates compare correctly as strings. */
export function coversMonth(w: EffectiveWindow, month: string): boolean {
  const d = monthFirstDay(month);
  return w.effectiveFrom <= d && (w.effectiveTo === null || w.effectiveTo >= d);
}
