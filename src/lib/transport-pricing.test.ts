import { describe, expect, test } from "bun:test";
import {
  MIN_SATANG,
  ONE_WAY_WORD,
  RATE_BAHT_PER_KM,
  ROUND_TRIP_WORD,
  defaultTripKm,
  formatKm,
  formatTripDate,
  kmToHundredths,
  tripAmountSatang,
  tripLabel,
  tripSourceRef,
} from "./transport-pricing";

// TASK-868 — what a trip pays. Integer satang; the minimum is PER TRIP, applied once, after a round trip doubled the km.

describe("tripAmountSatang — the TASK's five pricing cases", () => {
  test("7 km by car → 60 ฿ (the minimum: 7 × 6 = 42 < 60)", () => expect(tripAmountSatang(7, "car")).toBe(6_000));
  test("15 km by car → 90 ฿", () => expect(tripAmountSatang(15, "car")).toBe(9_000));
  test("10 km by motorbike → 40 ฿ (the minimum: 10 × 3 = 30 < 40)", () => expect(tripAmountSatang(10, "motorbike")).toBe(4_000));
  test("20 km by motorbike → 60 ฿", () => expect(tripAmountSatang(20, "motorbike")).toBe(6_000));
  test("a round trip doubles the km BEFORE the minimum: 4 km each way by car = 8 km → 48 ฿ → minimum 60; 6 km each way = 12 km → 72 ฿", () => {
    expect(tripAmountSatang(defaultTripKm(4, true), "car")).toBe(6_000);
    expect(tripAmountSatang(defaultTripKm(6, true), "car")).toBe(7_200);
  });
});

describe("the boundaries of the minimum", () => {
  test("car: exactly 10 km = 60 ฿ (equal to the minimum); 9.99 km → 59.94 → raised to 60; 10.01 km → 60.06", () => {
    expect(tripAmountSatang(10, "car")).toBe(6_000);
    expect(tripAmountSatang(9.99, "car")).toBe(6_000);
    expect(tripAmountSatang(10.01, "car")).toBe(6_006);
  });
  test("motorbike: exactly 13.33 km → 39.99 ฿ → raised to 40; 13.34 km → 40.02 ฿", () => {
    expect(tripAmountSatang(13.33, "motorbike")).toBe(4_000);
    expect(tripAmountSatang(13.34, "motorbike")).toBe(4_002);
  });
  test("the same km costs twice as much by car as by motorbike above both minimums", () => {
    expect(tripAmountSatang(50, "car")).toBe(2 * tripAmountSatang(50, "motorbike"));
  });
  test("the constants are the owner's: car 6 ฿/km min 60 ฿ · motorbike 3 ฿/km min 40 ฿", () => {
    expect(RATE_BAHT_PER_KM).toEqual({ car: 6, motorbike: 3 });
    expect(MIN_SATANG).toEqual({ car: 6_000, motorbike: 4_000 });
  });
});

describe("exact integer satang — no float ever", () => {
  test.each([0.01, 0.07, 1.1, 2.2, 12.34, 33.33, 99.99, 1234.56])("%p km: the result is a safe integer for both vehicles", (km) => {
    for (const v of ["car", "motorbike"] as const) expect(Number.isSafeInteger(tripAmountSatang(km, v))).toBe(true);
  });
  test("12.34 km by car = 74.04 ฿ exactly (1234 hundredths × 6)", () => expect(tripAmountSatang(12.34, "car")).toBe(7_404));
  test("0.1 + 0.2 style floats do not leak: 8.7 km by car = 52.2 ฿ → minimum", () => expect(tripAmountSatang(8.7, "car")).toBe(6_000));
  test("100.1 km by car = 600.60 ฿ (a figure that is not exact in binary)", () => expect(tripAmountSatang(100.1, "car")).toBe(60_060));
});

describe("refusals", () => {
  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("km %p is refused", (km) => expect(() => tripAmountSatang(km, "car")).toThrow());
  test("more than 2 decimals is refused, never rounded", () => {
    expect(() => tripAmountSatang(12.345, "car")).toThrow("more than 2 decimals");
    expect(() => kmToHundredths(0.001)).toThrow();
  });
  test("a vehicle other than car / motorbike is refused", () => {
    expect(() => tripAmountSatang(10, "bicycle" as never)).toThrow("unknown vehicle");
    expect(() => tripAmountSatang(10, null as never)).toThrow();
  });
  test("a string km is refused", () => expect(() => kmToHundredths("12" as never)).toThrow());
});

describe("defaultTripKm — the school's distance, doubled for a round trip", () => {
  test("one way = the distance; round trip = × 2", () => {
    expect(defaultTripKm(12, false)).toBe(12);
    expect(defaultTripKm(12, true)).toBe(24);
    expect(defaultTripKm(12.5, true)).toBe(25);
    expect(defaultTripKm(0.07, true)).toBe(0.14); // exact in hundredths: 7 × 2 = 14
  });
  test("a bad distance is refused", () => {
    expect(() => defaultTripKm(0, true)).toThrow();
    expect(() => defaultTripKm(1.234, false)).toThrow();
  });
});

describe("the pay line's words (R1.6): <school> · <dd/mm/yy> · <Round trip|One way> · <km> km", () => {
  test("a round trip", () => {
    expect(tripLabel({ schoolName: "STA", date: "2026-10-14", roundTrip: true, km: 24 })).toBe("STA · 14/10/26 · Round trip · 24 km");
  });
  test("one way", () => {
    expect(tripLabel({ schoolName: "ABC", date: "2026-01-05", roundTrip: false, km: 8 })).toBe("ABC · 05/01/26 · One way · 8 km");
  });
  test("the two words are the constants (the one-way word is ONE place to change)", () => {
    expect(ROUND_TRIP_WORD).toBe("Round trip"); // the agreed final UI's own pair (Porter's wording decision, 2026-11-08)
    expect(ONE_WAY_WORD).toBe("One way");
    expect(tripLabel({ schoolName: "X", date: "2026-10-14", roundTrip: false, km: 1 })).toContain(ONE_WAY_WORD);
    expect(tripLabel({ schoolName: "X", date: "2026-10-14", roundTrip: true, km: 1 })).toContain(ROUND_TRIP_WORD);
  });
  test("km has no trailing zeros and keeps real decimals; the name is trimmed", () => {
    expect(formatKm(12)).toBe("12");
    expect(formatKm(12.5)).toBe("12.5");
    expect(formatKm(12.34)).toBe("12.34");
    expect(tripLabel({ schoolName: "  NIS ", date: "2026-10-14", roundTrip: true, km: 36.5 })).toBe("NIS · 14/10/26 · Round trip · 36.5 km");
  });
  test("a bad date throws instead of printing nonsense", () => {
    expect(() => formatTripDate("2026-02-30")).toThrow("not a date");
    expect(() => formatTripDate("14/10/2026")).toThrow();
    expect(formatTripDate("2099-12-31")).toBe("31/12/99");
  });
  test("the idempotency key is trip:<id>", () => expect(tripSourceRef("abc")).toBe("trip:abc"));
});
