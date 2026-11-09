// TASK-926 - REPORT overview (SPEC-103 §4). DB-free: the pure rules + the service on a recording fake executor (query count, SQL pins, the CEO-vs-admin keys).
import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { TRIAL_CONVERSION_DAYS, inConversionWindow, monthEnd, reportOverview } from "./reports-overview.service";

const dialect = new PgDialect();
const NOW = () => new Date("2026-11-09T05:00:00Z"); // Bangkok 2026-11-09

describe("pure rules", () => {
  test("TRIAL_CONVERSION_DAYS is 60, and the window edge is exact: day 60 IN, day 61 OUT, never before the trial", () => {
    expect(TRIAL_CONVERSION_DAYS).toBe(60);
    expect(inConversionWindow("2026-01-01", "2026-01-01")).toBe(true); // the same day
    expect(inConversionWindow("2026-01-01", "2026-03-02")).toBe(true); // 60 days later
    expect(inConversionWindow("2026-01-01", "2026-03-03")).toBe(false); // 61 days later
    expect(inConversionWindow("2026-01-02", "2026-01-01")).toBe(false); // a sale BEFORE the trial cannot be its conversion
    expect(inConversionWindow("2025-12-31", "2026-03-01")).toBe(true); // across a year end: 60 days
    expect(inConversionWindow("2025-12-31", "2026-03-02")).toBe(false); // 62
  });
  test("monthEnd, leap February included", () => {
    expect(monthEnd("2026-11")).toBe("2026-11-30");
    expect(monthEnd("2026-12")).toBe("2026-12-31");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
  });
});

/** A recording executor: the canned rows come back in call order; every query is kept as {sql, params}. */
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
const S1 = "aaaaaaaa-1111-4111-8111-111111111111";
const S2 = "bbbbbbbb-2222-4222-8222-222222222222";
const S3 = "cccccccc-3333-4333-8333-333333333333"; // archived
const CANNED = (): Record<string, unknown>[][] => [
  [{ n: 4 }], // new students
  [{ student_id: S1, count: 1, subject_ids: [] }, { student_id: S2, count: 2, subject_ids: [] }, { student_id: S3, count: 1, subject_ids: [] }], // live entitlements (one grouped query)
  [{ id: S3 }], // archived ids
  [{ booked: 10, attended: 7, converted: 3 }], // trials
  [{ courses: 12, vouchers: 5 }], // sold
  [{ n: 140 }], // sessions taught
];
const summary = (calls: { date: string; branch?: string }[]) => async (date: string, branch?: string) => {
  calls.push({ date, branch });
  return { mtd: { totalMinor: 1_250_000, refundsMinor: -30_000 } };
};

describe("reportOverview", () => {
  test("every field, mapped; an ARCHIVED student is not active; trials ⊇ converted", async () => {
    const f = fake(CANNED());
    const r = await reportOverview({ month: "2026-10" }, "ceo", { exec: f.exec, now: NOW, summary: summary([]) });
    expect(r).toEqual({ month: "2026-10", newStudents: 4, activeStudents: 2, trialsBooked: 10, trials: 7, trialsConverted: 3, coursesSold: 12, vouchersSold: 5, sessionsTaught: 140, revenueMinor: 1_250_000, refundsMinor: -30_000 });
    expect(r.trialsConverted).toBeLessThanOrEqual(r.trials);
    expect(r.trials).toBeLessThanOrEqual(r.trialsBooked);
  });
  test("🔒 an admin gets NO money keys (absent, not zeroed), and the ledger is never called for them", async () => {
    const sc: { date: string; branch?: string }[] = [];
    const r = await reportOverview({ month: "2026-10" }, "admin", { exec: fake(CANNED()).exec, now: NOW, summary: summary(sc) });
    expect("revenueMinor" in r).toBe(false);
    expect("refundsMinor" in r).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/revenue|refund/i);
    expect(sc).toHaveLength(0);
    expect(r.newStudents).toBe(4);
  });
  test("the money comes from the ledger's own summary(): its date is the month's last day, or TODAY for the current month; the branch is passed on", async () => {
    const past: { date: string; branch?: string }[] = [];
    await reportOverview({ month: "2026-10", branch: "OTHER" }, "ceo", { exec: fake(CANNED()).exec, now: NOW, summary: summary(past) });
    expect(past).toEqual([{ date: "2026-10-31", branch: "OTHER" }]);
    const current: { date: string; branch?: string }[] = [];
    await reportOverview({ month: "2026-11" }, "ceo", { exec: fake(CANNED()).exec, now: NOW, summary: summary(current) });
    expect(current).toEqual([{ date: "2026-11-09", branch: undefined }]);
    const future: { date: string; branch?: string }[] = [];
    await reportOverview({ month: "2026-12" }, "ceo", { exec: fake(CANNED()).exec, now: NOW, summary: summary(future) });
    expect(future[0]!.date).toBe("2026-12-31");
  });
  test("active students: the shared live rule as of the month end (today for the current month)", async () => {
    const past = fake(CANNED());
    await reportOverview({ month: "2026-10" }, "admin", { exec: past.exec, now: NOW });
    expect(past.calls[1]!.params).toContain("2026-10-31");
    const cur = fake(CANNED());
    await reportOverview({ month: "2026-11" }, "admin", { exec: cur.exec, now: NOW });
    expect(cur.calls[1]!.params).toContain("2026-11-09");
  });
  test("a FIXED number of queries (6, plus the ledger's own), never per student or per trial", async () => {
    const f = fake(CANNED());
    await reportOverview({ month: "2026-10" }, "admin", { exec: f.exec, now: NOW });
    expect(f.calls).toHaveLength(6);
  });
  test("SQL pins: SALE only for sold; trials booked = not CANCELLED, attended = ATTENDED; the 60-day window and the TASK-860 link; sessions = ATTENDED lesson bookings", async () => {
    const f = fake(CANNED());
    await reportOverview({ month: "2026-10" }, "admin", { exec: f.exec, now: NOW });
    expect(f.calls[0]!.sql).toContain("s.archived_at is null");
    expect(f.calls[3]!.sql).toContain("b.booking_type = 'FIRST_TRIAL'");
    expect(f.calls[3]!.sql).toContain("b.status <> 'CANCELLED'");
    expect(f.calls[3]!.sql).toContain("b.status = 'ATTENDED' and (");
    expect(f.calls[3]!.sql).toContain("c.from_trial_booking_id = b.id and c.source = 'SALE'");
    expect(f.calls[3]!.sql).toContain("v.from_trial_booking_id = b.id and v.source = 'SALE'");
    expect(f.calls[3]!.sql.match(/between b\.date and b\.date \+ \$\d+::int/g)).toHaveLength(2); // the window is bound from the constant
    expect(f.calls[3]!.params.filter((p) => p === TRIAL_CONVERSION_DAYS)).toHaveLength(2);
    expect(f.calls[4]!.sql.match(/source = 'SALE'/g)).toHaveLength(2); // courses and vouchers: an IMPORT is never sold
    expect(f.calls[5]!.sql).toContain("b.status = 'ATTENDED' and b.booking_type in ('FIRST_TRIAL', 'SINGLE_SESSION', 'COURSE_PACKAGE', 'VOUCHER')");
  });
  test("branch filters bookings / courses / vouchers (not students); absent = no condition", async () => {
    const withB = fake(CANNED());
    await reportOverview({ month: "2026-10", branch: "BRAVO" }, "admin", { exec: withB.exec, now: NOW });
    expect(withB.calls[0]!.params).not.toContain("BRAVO"); // new students: not branch-scoped
    for (const i of [3, 4, 5]) expect(withB.calls[i]!.params).toContain("BRAVO");
    const noB = fake(CANNED());
    await reportOverview({ month: "2026-10" }, "admin", { exec: noB.exec, now: NOW });
    for (const c of noB.calls) expect(c.params).not.toContain("BRAVO");
  });
});
