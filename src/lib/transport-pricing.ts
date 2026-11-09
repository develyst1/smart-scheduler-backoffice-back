// TASK-868 (REQ-120 R1.2 / R1.6, SPEC-100 §3 / §9b) — what a transportation trip pays, and what its pay line is called.
// PURE: no database, no clock, no I/O. Money is integer SATANG.
//
//   car        6 ฿ / km, minimum 60 ฿ PER TRIP
//   motorbike  3 ฿ / km, minimum 40 ฿ PER TRIP
//
// The minimum applies to the trip AS ENTERED (not per leg): a round trip is distance × 2 first, and then the minimum applies
// once. `km` here is therefore the trip's TOTAL km (the stored `bo.transport_trip.km`, already doubled for a round trip).
//
// Exactness: a km figure has at most 2 decimals (numeric(8,2)), so km × 100 is an integer ("hundredths of a km"), and
//   amount (satang) = hundredths × rate (baht/km)         [ (h/100 km) × (rate ฿) × (100 satang/฿) = h × rate ]
// is an integer with NO rounding at all. A figure with more than 2 decimals is refused, never rounded.
export type Vehicle = "car" | "motorbike";

/** Baht per km. */
export const RATE_BAHT_PER_KM: Record<Vehicle, number> = { car: 6, motorbike: 3 };
/** The per-trip minimum, in satang (60 ฿ / 40 ฿). */
export const MIN_SATANG: Record<Vehicle, number> = { car: 6_000, motorbike: 4_000 };

/**
 * The two trip words on the pay line (R1.6). SETTLED (Porter, PM wording decision, 2026-11-08; Silver told): the agreed final UI's own pair,
 * "Round trip" / "One way" (Entries.tsx trip select). D2 = an English back office, slip included. One constant each: a swap is one line.
 */
export const ROUND_TRIP_WORD = "Round trip";
export const ONE_WAY_WORD = "One way";

/** km → hundredths of a km (an integer). Throws on anything that is not a positive number with at most 2 decimals. */
export function kmToHundredths(km: number): number {
  if (typeof km !== "number" || !Number.isFinite(km) || km <= 0) throw new Error(`km must be a positive number, got ${String(km)}`);
  const h = Math.round(km * 100);
  if (Math.abs(h - km * 100) > 1e-6) throw new Error(`km has more than 2 decimals: ${km}`);
  return h;
}

/** The pay of ONE trip: `max(minimum, km × rate)`, integer satang. `km` is the trip's total km. */
export function tripAmountSatang(km: number, vehicle: Vehicle): number {
  if (vehicle !== "car" && vehicle !== "motorbike") throw new Error(`unknown vehicle: ${String(vehicle)}`);
  return Math.max(MIN_SATANG[vehicle], kmToHundredths(km) * RATE_BAHT_PER_KM[vehicle]);
}

/** A school's distance → the default km of a trip to it: doubled for a round trip. Exact in hundredths, returned as a km figure. */
export function defaultTripKm(schoolDistanceKm: number, roundTrip: boolean): number {
  const h = kmToHundredths(schoolDistanceKm) * (roundTrip ? 2 : 1);
  return h / 100;
}

/** `12` → "12", `12.5` → "12.5", `12.34` → "12.34" (no trailing zeros, no thousands separator). */
export function formatKm(km: number): string {
  return String(kmToHundredths(km) / 100);
}

/** `2026-10-14` → `14/10/26` (dd/mm/yy). Throws on anything that is not a real calendar date. */
export function formatTripDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m || new Date(`${isoDate}T00:00:00Z`).toISOString().slice(0, 10) !== isoDate) throw new Error(`not a date: ${String(isoDate)}`);
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}

/** R1.6: `<school> · <date dd/mm/yy> · <Round trip|One way> · <km> km`. */
export function tripLabel(t: { schoolName: string; date: string; roundTrip: boolean; km: number }): string {
  return `${t.schoolName.trim()} · ${formatTripDate(t.date)} · ${t.roundTrip ? ROUND_TRIP_WORD : ONE_WAY_WORD} · ${formatKm(t.km)} km`;
}

/** The pay line's idempotency key for a trip. */
export const tripSourceRef = (tripId: string): string => `trip:${tripId}`;
