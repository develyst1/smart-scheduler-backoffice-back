import { describe, expect, test } from "bun:test";
import {
  bahtText,
  bangkokDate,
  buildBlock,
  CATEGORY_SEED,
  categorySeedRows,
  daysBetween,
  ecaAmountMinor,
  ecaRemark,
  ECA_TERM_MAX,
  escapeLike,
  feeFromMovements,
  feeKeys,
  followsRevenueLine,
  installmentsFit,
  INT32_MAX,
  isValidDate,
  paymentTotals,
  PAYMENT_REF_TYPES,
  planLabel,
  refundAmountMinor,
  refundKeyFor,
  REFUND_SOURCES_LIMIT,
  refundWithinFee,
  sessionCounts,
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

// ───────────────────────────────── TASK-890 — the ECA payment entry (R2.2) ─────────────────────────────────
describe("ecaAmountMinor — price per class × students × classes per term, integer satang", () => {
  test("the product of the three", () => {
    expect(ecaAmountMinor(150_000, 12, 10)).toBe(18_000_000); // 1,500 ฿ × 12 × 10
    expect(ecaAmountMinor(50_000, 1, 1)).toBe(50_000);
    expect(ecaAmountMinor(1, 1, 1)).toBe(1);
    expect(ecaAmountMinor(10_000, 25, 12)).toBe(3_000_000);
  });
  test("each factor counts (swapping any one changes the answer)", () => {
    expect(ecaAmountMinor(2, 3, 5)).toBe(30);
    expect(ecaAmountMinor(2, 3, 7)).toBe(42);
    expect(ecaAmountMinor(2, 4, 5)).toBe(40);
    expect(ecaAmountMinor(3, 3, 5)).toBe(45);
  });
  test("exactly INT32_MAX fits; one more does not (the column is a 32-bit int)", () => {
    expect(INT32_MAX).toBe(2_147_483_647);
    expect(ecaAmountMinor(INT32_MAX, 1, 1)).toBe(INT32_MAX);
    expect(ecaAmountMinor(INT32_MAX, 2, 1)).toBeNull();
    expect(ecaAmountMinor(1, INT32_MAX, 1)).toBe(INT32_MAX);
    expect(ecaAmountMinor(46_341, 46_341, 1)).toBeNull(); // 2,147,488,281
    expect(ecaAmountMinor(46_340, 46_340, 1)).toBe(2_147_395_600);
  });
  test("a product past 2^53 is refused, never rounded into range", () => {
    expect(ecaAmountMinor(2 ** 31 - 1, 2 ** 31 - 1, 2 ** 31 - 1)).toBeNull();
  });
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("a factor of %p is refused in every position", (bad) => {
    expect(ecaAmountMinor(bad, 1, 1)).toBeNull();
    expect(ecaAmountMinor(1, bad, 1)).toBeNull();
    expect(ecaAmountMinor(1, 1, bad)).toBeNull();
  });
  test("a non-number is refused", () => {
    expect(ecaAmountMinor("100" as never, 1, 1)).toBeNull();
    expect(ecaAmountMinor(null as never, 1, 1)).toBeNull();
  });
});

describe("bahtText / ecaRemark — the history line's words", () => {
  test("whole baht stay whole; fractions keep two digits", () => {
    expect(bahtText(150_000)).toBe("1500");
    expect(bahtText(100)).toBe("1");
    expect(bahtText(15_050)).toBe("150.50");
    expect(bahtText(15_005)).toBe("150.05");
    expect(bahtText(1)).toBe("0.01");
    expect(bahtText(99)).toBe("0.99");
  });
  test("the remark is '<price> ฿ × <students> students × <classes> classes'", () => {
    expect(ecaRemark(150_000, 12, 10)).toBe("1500 ฿ × 12 students × 10 classes");
    expect(ecaRemark(15_050, 1, 1)).toBe("150.50 ฿ × 1 students × 1 classes");
  });
  test("the term limit is 40", () => expect(ECA_TERM_MAX).toBe(40));
});

// ───────────────────────────────── TASK-893 — the refund (SPEC-099 §10) ─────────────────────────────────
describe("refund key, sign and amount rule", () => {
  test("one refund per sale: rl:refund:<type in lower case>:<id>, the type distinguishes a course from a voucher with the same id", () => {
    expect(refundKeyFor("COURSE", "abc")).toBe("rl:refund:course:abc");
    expect(refundKeyFor("VOUCHER", "abc")).toBe("rl:refund:voucher:abc");
    expect(refundKeyFor("COURSE", "abc")).not.toBe(refundKeyFor("VOUCHER", "abc"));
  });
  test("a refund is stored NEGATIVE (revenue_line_sign_ck: REFUND < 0), and it passes the sign rule", () => {
    expect(refundAmountMinor(95_000)).toBe(-95_000);
    expect(signOk("REFUND", refundAmountMinor(1))).toBe(true);
    expect(signOk("REFUND", 95_000)).toBe(false);
  });
  test("0 < amount <= fee: the fee itself is allowed, one satang over is not, zero / negative / fractional are not", () => {
    expect(refundWithinFee(95_000, 95_000)).toBe(true);
    expect(refundWithinFee(1, 95_000)).toBe(true);
    expect(refundWithinFee(95_001, 95_000)).toBe(false);
    expect(refundWithinFee(0, 95_000)).toBe(false);
    expect(refundWithinFee(-5, 95_000)).toBe(false);
    expect(refundWithinFee(10.5, 95_000)).toBe(false);
    expect(refundWithinFee(Number.NaN, 95_000)).toBe(false);
    expect(refundWithinFee(1, 0)).toBe(false); // a zero-fee sale has nothing to refund
  });
});

describe("escapeLike — the search text is literal", () => {
  test("% _ and the backslash are escaped; ordinary text and Thai are untouched", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("%_%")).toBe("\\%\\_\\%");
    expect(escapeLike("น้องเอ Pim")).toBe("น้องเอ Pim");
    expect(escapeLike("")).toBe("");
  });
});

describe("sessionCounts — what a refund would cancel", () => {
  const S = (status: string, date = "2026-11-20") => ({ status, date });
  test("attended = ATTENDED + NO_SHOW (held); toCancel = PENDING + CONFIRMED + EXTENDED; cancelled / leave / paused count as neither", () => {
    const rows = [S("ATTENDED"), S("NO_SHOW"), S("PENDING"), S("CONFIRMED"), S("EXTENDED"), S("CANCELLED"), S("SICK_LEAVE"), S("PAUSED"), S("PENDING_RESCHEDULE")];
    expect(sessionCounts("COURSE", rows, "2026-11-09", false)).toEqual({ attended: 2, toCancel: 3 });
  });
  test("a COURSE end forfeits every live row (no date rule); a VOUCHER end only the future ones (today counts)", () => {
    const rows = [S("CONFIRMED", "2026-11-01"), S("CONFIRMED", "2026-11-09"), S("PENDING", "2026-11-30")];
    expect(sessionCounts("COURSE", rows, "2026-11-09", false).toCancel).toBe(3);
    expect(sessionCounts("VOUCHER", rows, "2026-11-09", false).toCancel).toBe(2);
  });
  test("an ended plan has nothing left to cancel (the attended count stays)", () => {
    expect(sessionCounts("COURSE", [S("ATTENDED"), S("PENDING")], "2026-11-09", true)).toEqual({ attended: 1, toCancel: 0 });
    expect(sessionCounts("VOUCHER", [S("CONFIRMED")], "2026-11-09", true).toCancel).toBe(0);
  });
  test("no sessions ⇒ zeros", () => expect(sessionCounts("COURSE", [], "2026-11-09", false)).toEqual({ attended: 0, toCancel: 0 }));
});

describe("planLabel / bangkokDate / the limit", () => {
  test("nickname, else name; Course N / Voucher N Hr; no child ⇒ just the plan", () => {
    expect(planLabel("COURSE", { nickname: "Pim", name: "Alpha" }, 10)).toBe("Pim · Course 10");
    expect(planLabel("COURSE", { nickname: null, name: "Alpha" }, 4)).toBe("Alpha · Course 4");
    expect(planLabel("VOUCHER", { nickname: "  ", name: " Beta " }, 5)).toBe("Beta · Voucher 5 Hr");
    expect(planLabel("VOUCHER", null, 15)).toBe("Voucher 15 Hr");
  });
  test("the sold date is the BANGKOK date: 23:30 UTC on the 8th is the 9th in Bangkok", () => {
    expect(bangkokDate("2026-11-08T16:59:59Z")).toBe("2026-11-08");
    expect(bangkokDate("2026-11-08T17:00:00Z")).toBe("2026-11-09");
    expect(bangkokDate(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });
  test("at most 20 sources", () => expect(REFUND_SOURCES_LIMIT).toBe(20));
});
