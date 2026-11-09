import { describe, expect, test } from "bun:test";
import { courseLeft, isLiveCourse, isLiveVoucher, liveEntitlementsByStudent, voucherLeft } from "./reports-live";

const AS_OF = "2026-11-09";
const course = (o: Partial<Parameters<typeof isLiveCourse>[0]> = {}) => ({
  size: 10,
  priorSessions: 2,
  usedSessions: 3,
  endedAt: null,
  droppedAt: null,
  expiryDate: "2026-12-31",
  ...o,
});
const voucher = (o: Partial<Parameters<typeof isLiveVoucher>[0]> = {}) => ({
  totalHours: 10,
  usedHours: 4,
  endedAt: null,
  expiryDate: "2026-12-31",
  ...o,
});

describe("isLiveCourse (SPEC-103 §2/§7)", () => {
  test("a course with sessions left, not ended/paused/expired is live", () => expect(isLiveCourse(course(), AS_OF)).toBe(true));
  test("left = size − prior − used", () => {
    expect(courseLeft(course())).toBe(5);
    expect(isLiveCourse(course({ usedSessions: 8 }), AS_OF)).toBe(false); // 10-2-8 = 0
    expect(isLiveCourse(course({ usedSessions: 7 }), AS_OF)).toBe(true); // 1 left
    expect(isLiveCourse(course({ usedSessions: 9 }), AS_OF)).toBe(false); // negative
  });
  test("ended is not live", () => expect(isLiveCourse(course({ endedAt: new Date() }), AS_OF)).toBe(false));
  test("paused (dropped_at) is not live", () => expect(isLiveCourse(course({ droppedAt: "2026-11-01T00:00:00Z" }), AS_OF)).toBe(false));
  test("expiry edge: expiry == asOf is live, the day before is not", () => {
    expect(isLiveCourse(course({ expiryDate: AS_OF }), AS_OF)).toBe(true);
    expect(isLiveCourse(course({ expiryDate: "2026-11-08" }), AS_OF)).toBe(false);
  });
});

describe("isLiveVoucher", () => {
  test("hours left, not ended, not expired is live", () => expect(isLiveVoucher(voucher(), AS_OF)).toBe(true));
  test("hours: left = total − used, floored at 0", () => {
    expect(voucherLeft(voucher())).toBe(6);
    expect(voucherLeft(voucher({ usedHours: 12 }))).toBe(0);
    expect(isLiveVoucher(voucher({ usedHours: 10 }), AS_OF)).toBe(false);
    expect(isLiveVoucher(voucher({ usedHours: 9 }), AS_OF)).toBe(true);
  });
  test("ended is not live", () => expect(isLiveVoucher(voucher({ endedAt: "2026-11-01T00:00:00Z" }), AS_OF)).toBe(false));
  test("expired is not live; expiry == asOf is", () => {
    expect(isLiveVoucher(voucher({ expiryDate: "2026-11-08" }), AS_OF)).toBe(false);
    expect(isLiveVoucher(voucher({ expiryDate: AS_OF }), AS_OF)).toBe(true);
  });
  test("a voucher is never paused: the type has no droppedAt", () => {
    expect("droppedAt" in voucher()).toBe(false);
  });
});

describe("liveEntitlementsByStudent", () => {
  const sqlText = (q: unknown): string =>
    JSON.stringify((q as { queryChunks: unknown[] }).queryChunks.map((c) => (typeof c === "object" && c && "value" in c ? (c as { value: unknown }).value : c)));
  test("ONE query, mapped by student, subjects sorted, counts are numbers", async () => {
    const calls: unknown[] = [];
    const fake = {
      execute: async (q: unknown) => {
        calls.push(q);
        return [
          { student_id: "s1", count: 2, subject_ids: ["b", "a"] },
          { student_id: "s2", count: "1", subject_ids: [] },
        ];
      },
    };
    const m = await liveEntitlementsByStudent(AS_OF, fake as never);
    expect(calls.length).toBe(1);
    expect(m.get("s1")).toEqual({ count: 2, subjectIds: ["a", "b"] });
    expect(m.get("s2")).toEqual({ count: 1, subjectIds: [] });
    expect(m.size).toBe(2);
  });
  test("the SQL restates the rule: ended/dropped/left/expiry on courses, DUO co-student, voucher without dropped_at", async () => {
    let q: unknown;
    await liveEntitlementsByStudent(AS_OF, { execute: async (x: unknown) => ((q = x), []) } as never);
    const t = sqlText(q);
    expect(t).toContain("c.ended_at is null");
    expect(t).toContain("c.dropped_at is null");
    expect(t).toContain("c.size - coalesce(c.prior_sessions, 0) - c.used_sessions > 0");
    expect(t).toContain("c.co_student_id");
    expect(t).toContain("v.ended_at is null");
    expect(t).toContain("v.total_hours - v.used_hours > 0");
    expect(t).toContain("expiry_date >=");
    expect(t).not.toContain("v.dropped_at");
    expect(t).toContain("count(distinct eid)");
  });
  test("read-only: no insert/update/delete in the SQL", async () => {
    let q: unknown;
    await liveEntitlementsByStudent(AS_OF, { execute: async (x: unknown) => ((q = x), []) } as never);
    expect(sqlText(q)).not.toMatch(/\b(insert|update|delete)\b/i);
  });
});
