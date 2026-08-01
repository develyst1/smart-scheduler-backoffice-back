// SPEC-021 / TASK-064 — the attribution map and both groupings, tested without a DB.
import { describe, expect, test } from "bun:test";
import {
  attributeSales,
  groupByStudent,
  groupBySubject,
  inMonthBangkok,
  productKind,
  type AttributionSources,
  type SaleMovement,
} from "./revenue-attribution";

const SWIM = "subj-swim";
const FOOT = "subj-foot";
const STU_A = "stu-a";
const STU_B = "stu-b";

const at = (iso: string) => new Date(iso);
const sale = (productCode: string | null, refId: string | null, valueMinor: number): SaleMovement => ({
  productCode,
  refId,
  valueMinor,
  createdAt: at("2026-07-15T03:00:00Z"),
});

const sources: AttributionSources = {
  courses: new Map([["c1", { studentId: STU_A, subjectId: SWIM }]]),
  vouchers: new Map([["v1", { studentId: STU_B }]]),
  bookings: new Map([["b1", { studentId: STU_A, subjectId: FOOT }]]),
};

const names = (id: string) => ({ [SWIM]: "ว่ายน้ำ", [FOOT]: "ฟุตบอล", [STU_A]: "เอ", [STU_B]: "บี" })[id] ?? id;

describe("productKind — an unknown code must never look like an ordinary voucher", () => {
  test("the four shapes the codes actually take", () => {
    expect(productKind("course-6")).toBe("COURSE");
    expect(productKind("voucher-10")).toBe("VOUCHER");
    expect(productKind("first-trial")).toBe("BOOKING");
    expect(productKind("single-session")).toBe("BOOKING");
  });
  test("anything else is null — surfaced, not absorbed", () => {
    expect(productKind("membership-1")).toBeNull();
    expect(productKind("course-")).toBeNull();
    expect(productKind(null)).toBeNull();
  });
});

describe("attributeSales — the one map", () => {
  test("🔑 a course sale lands on its bookings' sport", () => {
    const [a] = attributeSales([sale("course-6", "c1", 5000)], sources);
    expect(a).toMatchObject({ kind: "COURSE", studentId: STU_A, subjectId: SWIM });
    expect(a.reason).toBeUndefined();
  });

  test("🔑 a trial/single sale lands on the booking's sport", () => {
    const [a] = attributeSales([sale("first-trial", "b1", 1390)], sources);
    expect(a).toMatchObject({ kind: "BOOKING", studentId: STU_A, subjectId: FOOT });
  });

  test("🔑 a voucher has NO sport but DOES have a customer — the reason one map serves both reports", () => {
    const [a] = attributeSales([sale("voucher-10", "v1", 9000)], sources);
    expect(a.subjectId).toBeNull();
    expect(a.reason).toBe("voucher");
    expect(a.studentId).toBe(STU_B); // ← unattributed by sport, fully attributed by customer
  });

  test("🔑 a sale whose refId no longer resolves is kept as unresolved — not dropped, not thrown", () => {
    const [a] = attributeSales([sale("course-6", "gone", 5000)], sources);
    expect(a).toMatchObject({ studentId: null, subjectId: null, reason: "unresolved" });
    expect(a.amountMinor).toBe(5000); // the money survives, which is what keeps the total honest
  });

  test("an unrecognised product code is flagged as such, NOT lumped in with vouchers", () => {
    const [a] = attributeSales([sale("membership-1", "x", 700)], sources);
    expect(a.reason).toBe("unknown-code");
  });

  test("a course with no bookings yet has no sport — unresolved, and its money still counts", () => {
    const [a] = attributeSales([sale("course-4", "c2", 4000)], {
      ...sources,
      courses: new Map([["c2", { studentId: STU_A, subjectId: null }]]),
    });
    expect(a).toMatchObject({ studentId: STU_A, subjectId: null, reason: "unresolved" });
  });

  test("every sale comes out exactly once — the identity below depends on it", () => {
    const sales = [sale("course-6", "c1", 1), sale("voucher-10", "v1", 2), sale("nope", null, 3)];
    expect(attributeSales(sales, sources)).toHaveLength(3);
  });
});

describe("🔴 buckets + unattributed === total — the report's correctness check", () => {
  const mixed = [
    sale("course-6", "c1", 5000), // → ว่ายน้ำ
    sale("first-trial", "b1", 1390), // → ฟุตบอล
    sale("voucher-10", "v1", 9000), // → unattributed (voucher)
    sale("course-6", "gone", 2500), // → unattributed (unresolved)
    sale("membership-1", "x", 700), // → unattributed (unknown code)
  ];

  test("asserted, not inspected", () => {
    const r = groupBySubject(attributeSales(mixed, sources), "2026-07", names);
    const bucketSum = r.buckets.reduce((s, b) => s + b.amountMinor, 0);
    expect(bucketSum + r.unattributedMinor).toBe(r.totalMinor);
    expect(r.totalMinor).toBe(5000 + 1390 + 9000 + 2500 + 700);
  });

  test("holds when NOTHING is attributable (the state before the write path was repaired)", () => {
    const r = groupBySubject(attributeSales([sale("voucher-10", "v1", 9000)], sources), "2026-07", names);
    expect(r.buckets).toHaveLength(0);
    expect(r.unattributedMinor).toBe(r.totalMinor);
  });

  test("holds when there are no sales at all", () => {
    const r = groupBySubject([], "2026-07", names);
    expect(r.totalMinor).toBe(0);
    expect(r.unattributedMinor).toBe(0);
  });

  test("the reason names EVERY cause with counts — an unknown code can't hide inside 'just vouchers'", () => {
    const r = groupBySubject(attributeSales(mixed, sources), "2026-07", names);
    expect(r.unattributedReason).toContain("1 vouchers");
    expect(r.unattributedReason).toContain("1 sales whose reference no longer resolves");
    expect(r.unattributedReason).toContain("unrecognised product code");
  });

  test("buckets carry real names and sort by size", () => {
    const r = groupBySubject(attributeSales(mixed, sources), "2026-07", names);
    expect(r.buckets.map((b) => b.name)).toEqual(["ว่ายน้ำ", "ฟุตบอล"]);
  });
});

describe("groupByStudent — the SAME list, grouped the other way", () => {
  const mixed = [
    sale("course-6", "c1", 5000),
    sale("first-trial", "b1", 1390),
    sale("voucher-10", "v1", 9000),
    sale("course-6", "gone", 2500), // no customer → omitted here, still in revenue's unattributed
  ];

  test("🔑 a voucher counts fully against its customer even though it has no sport", () => {
    const rows = groupByStudent(attributeSales(mixed, sources), names);
    expect(rows.find((r) => r.studentId === STU_B)).toMatchObject({
      totalSpendMinor: 9000,
      vouchers: 1,
      courses: 0,
      sessions: 0,
    });
  });

  test("a customer's purchases across kinds roll up into one row", () => {
    const rows = groupByStudent(attributeSales(mixed, sources), names);
    expect(rows.find((r) => r.studentId === STU_A)).toMatchObject({
      totalSpendMinor: 6390,
      courses: 1,
      sessions: 1,
    });
  });

  test("sorted by spend, and `q` filters by name", () => {
    const rows = groupByStudent(attributeSales(mixed, sources), names);
    expect(rows[0].studentId).toBe(STU_B); // 9000 > 6390
    expect(groupByStudent(attributeSales(mixed, sources), names, "บี")).toHaveLength(1);
  });

  test("⚠️ customer-spend total is NOT the month total — the unresolved sale has no customer", () => {
    const attributed = attributeSales(mixed, sources);
    const spend = groupByStudent(attributed, names).reduce((s, r) => s + r.totalSpendMinor, 0);
    const revenue = groupBySubject(attributed, "2026-07", names).totalMinor;
    expect(spend).toBe(revenue - 2500); // by design: it stays visible in revenue's `unattributed`
  });
});

describe("🔴 month boundary in Bangkok (TASK-062's lesson — here it would MOVE revenue)", () => {
  test("01 Aug 02:00 Bangkok is August, not July", () => {
    // 31 Jul 19:00 UTC. A toISOString() comparison would file this under July.
    expect(inMonthBangkok(at("2026-07-31T19:00:00Z"), "2026-08")).toBe(true);
    expect(inMonthBangkok(at("2026-07-31T19:00:00Z"), "2026-07")).toBe(false);
  });

  test("31 Jul 23:00 Bangkok is still July", () => {
    expect(inMonthBangkok(at("2026-07-31T16:00:00Z"), "2026-07")).toBe(true);
  });

  test("the other boundary: 01 Jul 00:30 Bangkok is July, not June", () => {
    expect(inMonthBangkok(at("2026-06-30T17:30:00Z"), "2026-07")).toBe(true);
    expect(inMonthBangkok(at("2026-06-30T17:30:00Z"), "2026-06")).toBe(false);
  });

  test("🔑 the SQL range agrees with the predicate exactly — a row can't be fetched-then-dropped or missed", () => {
    for (const month of ["2026-07", "2026-08", "2026-12", "2026-01"]) {
      const { start, end } = bangkokMonthRangeUtc(month);
      // The instant the month opens is IN; one millisecond earlier is out; the closing instant is out.
      expect(inMonthBangkok(start, month)).toBe(true);
      expect(inMonthBangkok(new Date(start.getTime() - 1), month)).toBe(false);
      expect(inMonthBangkok(new Date(end.getTime() - 1), month)).toBe(true);
      expect(inMonthBangkok(end, month)).toBe(false);
    }
  });

  test("December rolls into the next year, not month 13", () => {
    expect(bangkokMonthRangeUtc("2026-12").end.toISOString()).toBe("2026-12-31T17:00:00.000Z");
  });
});
