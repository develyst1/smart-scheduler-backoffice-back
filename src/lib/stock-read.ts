// TASK-904 — the pure bits of the Stock reads: the movement TYPE vocabulary, the date window (Bangkok days, inclusive, ≤ 366), LIKE escaping.
// The vocabulary is the FE's final labels: Sale · Stock in · Adjustment · From Demo. It is derived from `ref_type` / the sign of `qty`
// (there is no type column on `bo.movement`): an import or a manual correction is ADJUSTMENT; a «FROM_DEMO» ref is FROM_DEMO; otherwise
// an OUT is a SALE and an IN is STOCK_IN.
export const MOVEMENT_TYPES = ["SALE", "STOCK_IN", "ADJUSTMENT", "FROM_DEMO"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

// 🔻 TASK-911: STOCK_OPENING = the opening balance of a product created by hand (like an import's, an adjustment, not a delivery)
const ADJUSTMENT_REFS = new Set(["STOCK_IMPORT", "STOCK_OPENING", "ADJUSTMENT", "RESET", "TOPUP"]);

/** 🔻 TASK-911 - the Asia/Bangkok calendar day (YYYY-MM-DD) of an instant; Bangkok is UTC+7 with no DST. */
export const bangkokDate = (d: Date): string => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export function movementTypeOf(m: { qty: number; refType: string | null }): MovementType {
  const ref = (m.refType ?? "").toUpperCase();
  if (ref === "FROM_DEMO") return "FROM_DEMO";
  if (ADJUSTMENT_REFS.has(ref)) return "ADJUSTMENT";
  return m.qty < 0 ? "SALE" : "STOCK_IN";
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day as UTC ms, else null («2026-02-30» is not a day). */
function dayMs(d: string): number | null {
  const m = DAY.exec(d);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10) === d ? t : null;
}

/** to − from in days (inclusive window ⇒ the span, not the count); null when either is not a real day. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayMs(from), b = dayMs(to);
  return a === null || b === null ? null : Math.round((b - a) / 86_400_000);
}

/** [from 00:00 Bangkok, the day after `to` 00:00 Bangkok) as instants — `to` is INCLUSIVE. */
export function bangkokDayBounds(from: string, to: string): { start: Date; end: Date } {
  const a = dayMs(from)!, b = dayMs(to)!;
  const OFFSET = 7 * 3_600_000;
  return { start: new Date(a - OFFSET), end: new Date(b + 86_400_000 - OFFSET) };
}

/** A user search term inside LIKE: % and _ and \ are literal. */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
