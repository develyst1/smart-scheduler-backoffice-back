// TASK-926 - COURSE (SPEC-103 §2). DB-free: the pure assembly + the service on a recording fake executor (so the query count and the SQL pins are checked without a database).
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { assembleCourses, reportCourses } from "./reports-courses.service";

const dialect = new PgDialect();
const SKATE = "11111111-1111-4111-8111-111111111111";
const BIKE = "22222222-2222-4222-8222-222222222222";
const names = new Map([[SKATE, "Skateboard"], [BIKE, "Balance bike"]]);

const base = () => ({
  courses: [
    { subjectId: SKATE, kind: "DUO" as const, size: 6, sold: 1, active: 2, paused: 0, ended: 0 },
    { subjectId: SKATE, kind: "PRIVATE" as const, size: 10, sold: 3, active: 4, paused: 1, ended: 2 },
    { subjectId: SKATE, kind: "PRIVATE" as const, size: 4, sold: 5, active: 6, paused: 0, ended: 1 },
    { subjectId: BIKE, kind: "PRIVATE" as const, size: 4, sold: 0, active: 0, paused: 0, ended: 0 }, // an empty row is not listed
  ],
  vouchers: [{ size: 10, sold: 2, active: 3, ended: 1 }],
  courseSessions: [{ subjectId: SKATE, kind: "PRIVATE" as const, size: 4, n: 7 }, { subjectId: BIKE, kind: "PRIVATE" as const, size: 4, n: 2 }],
  voucherSessions: [{ size: 10, n: 5 }],
  revenue: { courses: [{ subjectId: SKATE, kind: "PRIVATE" as const, size: 4, amount: 100_000 }], vouchers: [{ size: 10, amount: 50_000 }], unmatched: 9_900 },
  names,
});

describe("assembleCourses (pure)", () => {
  test("one row per activity × kind × size; voucher rows are per SIZE with subjectId null and the name «Voucher»", () => {
    const { rows } = assembleCourses(base());
    expect(rows.map((r) => [r.subjectName, r.kind, r.size])).toEqual([
      ["Balance bike", "PRIVATE", 4], // its sessions make it a row even with nothing sold
      ["Skateboard", "PRIVATE", 4],
      ["Skateboard", "PRIVATE", 10],
      ["Skateboard", "DUO", 6],
      ["Voucher", "VOUCHER", 10],
    ]);
    expect(rows.find((r) => r.kind === "VOUCHER")).toMatchObject({ subjectId: null, subjectName: "Voucher", paused: 0, sold: 2, active: 3, ended: 1, sessionsTaught: 5 });
  });
  test("order: activity name, then kind (PRIVATE, DUO, VOUCHER), then size", () => {
    const { rows } = assembleCourses(base());
    const skate = rows.filter((r) => r.subjectName === "Skateboard").map((r) => `${r.kind}${r.size}`);
    expect(skate).toEqual(["PRIVATE4", "PRIVATE10", "DUO6"]);
  });
  test("sold / active / paused / ended / sessionsTaught are carried per row; the totals are the column sums", () => {
    const { rows, totals } = assembleCourses(base());
    expect(rows.find((r) => r.subjectName === "Skateboard" && r.kind === "PRIVATE" && r.size === 4)).toMatchObject({ sold: 5, active: 6, paused: 0, ended: 1, sessionsTaught: 7, revenueMinor: 100_000 });
    expect(totals).toEqual({ sold: 1 + 3 + 5 + 2, active: 2 + 4 + 6 + 3, paused: 1, ended: 2 + 1 + 1, sessionsTaught: 7 + 2 + 5, revenueMinor: 150_000, unmatchedRevenueMinor: 9_900 });
  });
  test("🔒 CEO vs admin: for an admin the money keys are ABSENT (not zeroed), on every row and in the totals", () => {
    const admin = assembleCourses({ ...base(), revenue: null });
    for (const r of admin.rows) expect("revenueMinor" in r).toBe(false);
    expect("revenueMinor" in admin.totals).toBe(false);
    expect("unmatchedRevenueMinor" in admin.totals).toBe(false);
    expect(JSON.stringify(admin)).not.toMatch(/revenue/i);
    const ceo = assembleCourses(base());
    for (const r of ceo.rows) expect("revenueMinor" in r).toBe(true);
    expect(ceo.totals.unmatchedRevenueMinor).toBe(9_900);
  });
  test("unmatched revenue is a TOTAL only: it is never guessed into a row", () => {
    const r = assembleCourses({ ...base(), revenue: { courses: [], vouchers: [], unmatched: 77_700 } });
    expect(r.rows.every((x) => x.revenueMinor === 0)).toBe(true);
    expect(r.totals).toMatchObject({ revenueMinor: 0, unmatchedRevenueMinor: 77_700 });
  });
  test("a revenue-only row (an old course paid today) is listed with sold = 0", () => {
    const r = assembleCourses({ courses: [], vouchers: [], courseSessions: [], voucherSessions: [], revenue: { courses: [{ subjectId: BIKE, kind: "DUO", size: 10, amount: 5_000 }], vouchers: [], unmatched: 0 }, names });
    expect(r.rows).toEqual([{ subjectId: BIKE, subjectName: "Balance bike", kind: "DUO", size: 10, sold: 0, active: 0, paused: 0, ended: 0, sessionsTaught: 0, revenueMinor: 5_000 }]);
  });
  test("an unknown activity id reads «—», never a crash", () => {
    const r = assembleCourses({ ...base(), names: new Map() });
    expect(r.rows.some((x) => x.subjectName === "—")).toBe(true);
  });
});

/** A recording executor: every query is captured as {sql, params}; the canned rows come back in call order. */
function fake(canned: Record<string, unknown>[][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let i = 0;
  return {
    calls,
    exec: {
      execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
        const { sql, params } = dialect.sqlToQuery(q);
        calls.push({ sql: sql.replace(/\s+/g, " "), params });
        return canned[i++] ?? [];
      },
    },
  };
}
const CANNED = (): Record<string, unknown>[][] => [
  [{ subject_id: SKATE, kind: "PRIVATE", size: 4, sold: 5, active: 6, paused: 1, ended: 2 }], // courses
  [{ size: 10, sold: 2, active: 3, ended: 1 }], // vouchers
  [{ subject_id: SKATE, kind: "PRIVATE", size: 4, n: 7 }], // course sessions
  [{ size: 10, n: 4 }], // voucher sessions
  [{ subject_id: SKATE, ckind: "PRIVATE", csize: 4, vsize: null, amount: "100000" }, { subject_id: null, ckind: null, csize: null, vsize: 10, amount: "50000" }, { subject_id: null, ckind: null, csize: null, vsize: null, amount: "9900" }], // revenue
  [{ id: SKATE, name: "Skateboard" }], // names
];

describe("reportCourses (the queries)", () => {
  const Q = { from: "2026-11-01", to: "2026-11-09" };
  const NOW = () => new Date("2026-11-09T05:00:00Z");

  test("a FIXED number of grouped queries: 6 for the CEO, 5 for an admin (no revenue query), never per row", async () => {
    const ceo = fake(CANNED());
    await reportCourses(Q, "ceo", { exec: ceo.exec, now: NOW });
    expect(ceo.calls).toHaveLength(6);
    const admin = fake([...CANNED().slice(0, 4), CANNED()[5]!]);
    await reportCourses(Q, "admin", { exec: admin.exec, now: NOW });
    expect(admin.calls).toHaveLength(5);
    expect(admin.calls.some((c) => c.sql.includes("bo.revenue_line"))).toBe(false); // an admin's request never touches the revenue table
  });
  test("the CEO's rows carry revenue (joined by ref_type + ref_id); the unmatched line is in the totals only", async () => {
    const f = fake(CANNED());
    const r = await reportCourses(Q, "ceo", { exec: f.exec, now: NOW });
    expect(r.rows.find((x) => x.kind === "PRIVATE")).toMatchObject({ subjectName: "Skateboard", sold: 5, active: 6, paused: 1, ended: 2, sessionsTaught: 7, revenueMinor: 100_000 });
    expect(r.rows.find((x) => x.kind === "VOUCHER")).toMatchObject({ revenueMinor: 50_000, sessionsTaught: 4 });
    expect(r.totals).toMatchObject({ revenueMinor: 150_000, unmatchedRevenueMinor: 9_900 });
    const rev = f.calls[4]!.sql;
    expect(rev).toContain("r.ref_type = 'COURSE' and r.ref_id = c.id::text");
    expect(rev).toContain("r.ref_type = 'VOUCHER' and r.ref_id = v.id::text");
    expect(rev).toContain("r.type in ('COURSE', 'VOUCHER')"); // REFUND is not course revenue
    expect(rev).toContain("r.occurred_on between"); // the window is the ledger's own date, whatever the sale date
  });
  test("🔒 an admin gets NO revenue key anywhere in the JSON", async () => {
    const f = fake([...CANNED().slice(0, 4), CANNED()[5]!]);
    const r = await reportCourses(Q, "admin", { exec: f.exec, now: NOW });
    expect(JSON.stringify(r)).not.toMatch(/revenue/i);
    expect(r.rows.length).toBeGreaterThan(0);
  });
  test("IMPORT never counts as sold: `sold` is filtered to source = 'SALE' for courses AND vouchers", async () => {
    const f = fake(CANNED());
    await reportCourses(Q, "ceo", { exec: f.exec, now: NOW });
    expect(f.calls[0]!.sql).toContain("c.source = 'SALE' and (c.created_at at time zone 'Asia/Bangkok')::date between");
    expect(f.calls[1]!.sql).toContain("v.source = 'SALE' and (v.created_at at time zone 'Asia/Bangkok')::date between");
  });
  test("active is as of `to`: dates as of `to`, expiry >= to, sessions / hours left; a voucher is never paused", async () => {
    const f = fake(CANNED());
    await reportCourses(Q, "ceo", { exec: f.exec, now: NOW });
    const c = f.calls[0]!.sql;
    expect(c).toContain("(c.ended_at is null or (c.ended_at at time zone 'Asia/Bangkok')::date > $");
    expect(c).toContain("c.size - coalesce(c.prior_sessions, 0) - c.used_sessions > 0 and c.expiry_date >=");
    expect(c).toContain("c.dropped_at is not null");
    expect(f.calls[1]!.sql).not.toContain("dropped_at");
    expect(f.calls[1]!.sql).toContain("v.total_hours - v.used_hours > 0 and v.expiry_date >=");
  });
  test("kind: co_student_id set = DUO, else PRIVATE (a group seat reads PRIVATE)", async () => {
    const f = fake(CANNED());
    await reportCourses(Q, "ceo", { exec: f.exec, now: NOW });
    expect(f.calls[0]!.sql).toContain("case when c.co_student_id is null then 'PRIVATE' else 'DUO' end");
  });
  test("branch filters every measure and the revenue; absent = no branch condition", async () => {
    const withB = fake(CANNED());
    await reportCourses({ ...Q, branch: "BRAVO" }, "ceo", { exec: withB.exec, now: NOW });
    for (const i of [0, 1, 2, 3, 4]) expect(withB.calls[i]!.params).toContain("BRAVO");
    const noB = fake(CANNED());
    await reportCourses(Q, "ceo", { exec: noB.exec, now: NOW });
    for (const c of noB.calls) expect(c.params).not.toContain("BRAVO");
  });
  test("activeIsApprox: true when `to` is before today (Bangkok), false for `to` = today or later", async () => {
    expect((await reportCourses({ from: "2026-10-01", to: "2026-10-31" }, "ceo", { exec: fake(CANNED()).exec, now: NOW })).activeIsApprox).toBe(true);
    expect((await reportCourses({ from: "2026-11-01", to: "2026-11-09" }, "ceo", { exec: fake(CANNED()).exec, now: NOW })).activeIsApprox).toBe(false);
    expect((await reportCourses({ from: "2026-11-01", to: "2026-11-30" }, "ceo", { exec: fake(CANNED()).exec, now: NOW })).activeIsApprox).toBe(false);
    // Bangkok day: 2026-11-08T18:00Z is already 2026-11-09 in Bangkok
    expect((await reportCourses({ from: "2026-11-01", to: "2026-11-08" }, "ceo", { exec: fake(CANNED()).exec, now: () => new Date("2026-11-08T18:00:00Z") })).activeIsApprox).toBe(true);
  });
  test("sessionsTaught counts ATTENDED bookings in the window by the COURSE's activity / kind / size, and voucher bookings by the voucher's size", async () => {
    const f = fake(CANNED());
    await reportCourses(Q, "ceo", { exec: f.exec, now: NOW });
    expect(f.calls[2]!.sql).toContain("b.status = 'ATTENDED' and b.date between");
    expect(f.calls[2]!.sql).toContain("join public.course_packages c on c.id = b.course_id");
    expect(f.calls[3]!.sql).toContain("join public.vouchers v on v.id = b.voucher_id");
  });
  test("a bad role is refused", async () => {
    await expect(reportCourses(Q, "coach" as never, { exec: fake([]).exec })).rejects.toMatchObject({ status: 403 });
  });
});
