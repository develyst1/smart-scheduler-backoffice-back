import { describe, expect, test } from "bun:test";
import {
  buildBlock,
  CATEGORY_SEED,
  categorySeedRows,
  daysBetween,
  feeFromMovements,
  feeKeys,
  followsRevenueLine,
  installmentsFit,
  isValidDate,
  paymentTotals,
  PAYMENT_REF_TYPES,
  REVENUE_TYPES,
  revenueLineKeyFor,
  signOk,
  summaryWindows,
} from "./revenue-ledger";

describe("category seed (SPEC-098 §2)", () => {
  test("exactly 53 rows, per type 26/8/3/5/4/2/2/3", () => {
    const rows = categorySeedRows();
    expect(rows.length).toBe(53);
    const counts = REVENUE_TYPES.map((t) => rows.filter((r) => r.type === t).length);
    expect(counts).toEqual([26, 8, 3, 5, 4, 2, 2, 3]);
  });

  test("sort_order counts 0,1,2… within each type; types in §2's order", () => {
    const rows = categorySeedRows();
    for (const t of REVENUE_TYPES) {
      expect(rows.filter((r) => r.type === t).map((r) => r.sortOrder)).toEqual(
        CATEGORY_SEED[t].map((_, i) => i),
      );
    }
    expect([...new Set(rows.map((r) => r.type))]).toEqual([...REVENUE_TYPES]);
  });

  test("no duplicate (type, lower(name)) — the unique index would reject the migration", () => {
    const keys = categorySeedRows().map((r) => `${r.type}|${r.name.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("COURSE is sport-major (Private, Duo, 1 HR) then Balance Camp, Birthday", () => {
    expect(CATEGORY_SEED.COURSE.slice(0, 3)).toEqual([
      "Inline Skate · Private",
      "Inline Skate · Duo",
      "Inline Skate · 1 HR",
    ]);
    expect(CATEGORY_SEED.COURSE.slice(-2)).toEqual(["Balance Camp", "Birthday"]);
  });
});

describe("sign rule", () => {
  test("REFUND must be negative; every other type must be positive", () => {
    expect(signOk("REFUND", -1)).toBe(true);
    expect(signOk("REFUND", 0)).toBe(false);
    expect(signOk("REFUND", 100)).toBe(false);
    expect(signOk("COURSE", 100)).toBe(true);
    expect(signOk("COURSE", 0)).toBe(false);
    expect(signOk("COURSE", -100)).toBe(false);
  });
  test("non-integer satang is never ok", () => {
    expect(signOk("COURSE", 1.5)).toBe(false);
    expect(signOk("REFUND", -1.5)).toBe(false);
  });
});

describe("dates", () => {
  test("isValidDate accepts real calendar dates only", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-1-1")).toBe(false);
    expect(isValidDate("2026-04-31")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });
  test("daysBetween is inclusive-span arithmetic across month, leap day and year edges", () => {
    expect(daysBetween("2026-01-01", "2026-01-01")).toBe(0);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2); // 29 Feb exists
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetween("2026-01-01", "2027-01-02")).toBe(366);
  });
});

describe("summary windows (Today / MTD / YTD)", () => {
  test("1 Jan: all three windows collapse to that day", () => {
    const w = summaryWindows("2026-01-01");
    expect(w.today).toEqual({ from: "2026-01-01", to: "2026-01-01" });
    expect(w.mtd).toEqual({ from: "2026-01-01", to: "2026-01-01" });
    expect(w.ytd).toEqual({ from: "2026-01-01", to: "2026-01-01" });
  });
  test("the 1st of a month: MTD is one day, YTD reaches back to 1 Jan", () => {
    const w = summaryWindows("2026-11-01");
    expect(w.mtd).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(w.ytd).toEqual({ from: "2026-01-01", to: "2026-11-01" });
  });
  test("29 Feb 2028 (leap day)", () => {
    const w = summaryWindows("2028-02-29");
    expect(w.today).toEqual({ from: "2028-02-29", to: "2028-02-29" });
    expect(w.mtd).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(w.ytd).toEqual({ from: "2028-01-01", to: "2028-02-29" });
  });
  test("a mid-month date", () => {
    const w = summaryWindows("2026-11-08");
    expect(w.mtd).toEqual({ from: "2026-11-01", to: "2026-11-08" });
  });
});

describe("buildBlock", () => {
  test("empty input → all 8 types, zero-filled, in §2's order", () => {
    const b = buildBlock([]);
    expect(b.rows.map((r) => r.type)).toEqual([...REVENUE_TYPES]);
    expect(b.rows.every((r) => r.amountMinor === 0)).toBe(true);
    expect(b.totalMinor).toBe(0);
    expect(b.refundsMinor).toBe(0);
  });
  test("refunds are kept apart: not in totalMinor, summed in refundsMinor", () => {
    const b = buildBlock([
      { type: "COURSE", amountMinor: 1100000 },
      { type: "SALES", amountMinor: 351000 },
      { type: "REFUND", amountMinor: -50000 },
    ]);
    expect(b.rows.find((r) => r.type === "COURSE")?.amountMinor).toBe(1100000);
    expect(b.rows.find((r) => r.type === "FNB")?.amountMinor).toBe(0);
    expect(b.totalMinor).toBe(1451000);
    expect(b.refundsMinor).toBe(-50000);
  });
  test("repeated types are summed; an unknown type is ignored, not bucketed", () => {
    const b = buildBlock([
      { type: "ECA", amountMinor: 100 },
      { type: "ECA", amountMinor: 200 },
      { type: "MYSTERY", amountMinor: 999 },
    ]);
    expect(b.rows.find((r) => r.type === "ECA")?.amountMinor).toBe(300);
    expect(b.totalMinor).toBe(300);
  });
});

// ═══════════════ TASK-874 — the F2 payment record: the pure rules (SPEC-099 §8) ═══════════════
describe("payments — the fee (the sale's net, from its posted movements)", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  test("slice 2a covers COURSE and VOUCHER only", () => {
    expect([...PAYMENT_REF_TYPES]).toEqual(["COURSE", "VOUCHER"]);
  });
  test("the keys are the ones the sale paths write: course-sale / voucher-sale, and discount:<id>", () => {
    expect(feeKeys("COURSE", ID)).toEqual({ sale: `course-sale:${ID}`, discount: `discount:${ID}` });
    expect(feeKeys("VOUCHER", ID)).toEqual({ sale: `voucher-sale:${ID}`, discount: `discount:${ID}` });
  });
  test("fee = sale + the (negative) discount", () => {
    expect(feeFromMovements("COURSE", ID, [{ key: `course-sale:${ID}`, valueMinor: 1000000 }, { key: `discount:${ID}`, valueMinor: -50000 }])).toBe(950000);
  });
  test("no discount → the fee is the whole sale", () => {
    expect(feeFromMovements("VOUCHER", ID, [{ key: `voucher-sale:${ID}`, valueMinor: 1050000 }])).toBe(1050000);
  });
  test("no sale movement → null (a discount alone is not a fee)", () => {
    expect(feeFromMovements("COURSE", ID, [])).toBeNull();
    expect(feeFromMovements("COURSE", ID, [{ key: `discount:${ID}`, valueMinor: -50000 }])).toBeNull();
  });
  test("another sale's movements, or the other kind's key, never count", () => {
    const other = "99999999-9999-4999-8999-999999999999";
    expect(feeFromMovements("COURSE", ID, [{ key: `course-sale:${other}`, valueMinor: 5 }, { key: `voucher-sale:${ID}`, valueMinor: 7 }, { key: null, valueMinor: 9 }])).toBeNull();
  });
});

describe("payments — installments split the fee (§8.9)", () => {
  test("sum(rows) <= fee fits, the boundary included", () => {
    expect(installmentsFit(950000, [500000, 450000])).toBe(true);
    expect(installmentsFit(950000, [500000, 450001])).toBe(false);
    expect(installmentsFit(950000, [])).toBe(true);
  });
  test("paymentTotals: paid = Σ rows, remaining = fee − paid", () => {
    expect(paymentTotals(950000, [500000, 250000])).toEqual({ feeMinor: 950000, paidMinor: 750000, remainingMinor: 200000 });
  });
  test("no fee → remaining is null, paid is still the sum", () => {
    expect(paymentTotals(null, [123])).toEqual({ feeMinor: null, paidMinor: 123, remainingMinor: null });
  });
  test("an over-paid sale reads a negative remainder instead of hiding it", () => {
    expect(paymentTotals(100, [150]).remainingMinor).toBe(-50);
  });
});

describe("payments — the revenue line follows ROW 1's method only (§8.4)", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  test("the line key is rl:<kind lower-cased>:<id>, as TASK-864 writes it", () => {
    expect(revenueLineKeyFor("COURSE", ID)).toBe(`rl:course:${ID}`);
    expect(revenueLineKeyFor("VOUCHER", ID)).toBe(`rl:voucher:${ID}`);
  });
  test("row 1 + a method change follows", () => {
    expect(followsRevenueLine(1, { method: "CASH" })).toBe(true);
  });
  test("an installment (n >= 2) never follows, whatever changes", () => {
    for (const n of [2, 3, 10]) expect(followsRevenueLine(n, { method: "CASH" })).toBe(false);
  });
  test("row 1 with only a date or amount change does not follow (only the METHOD is on the line)", () => {
    expect(followsRevenueLine(1, {})).toBe(false);
    expect(followsRevenueLine(1, { method: undefined })).toBe(false);
  });
});
