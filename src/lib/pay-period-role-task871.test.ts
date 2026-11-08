// TASK-871 / SPEC-101 §3–§4 — the two pure rules everything else reads: the R1.4 pay-period range and roleOfDay.
import { describe, expect, test } from "bun:test";
import { payPeriodRange } from "./pay-period";
import { dayOfWeek, effectiveRoles, isWeekend, roleOfDay, rolesProblem } from "./role-of-day";

describe("payPeriodRange (R1.4: last day of the previous month → the day BEFORE the last day of this month)", () => {
  test("October 2026 is 30/9–30/10 (the customer's own example)", () => {
    expect(payPeriodRange(2026, 10)).toEqual({ start: "2026-09-30", end: "2026-10-30" });
  });
  test("November 2026 is 31/10–29/11 (a 30-day month ends on the 29th)", () => {
    expect(payPeriodRange(2026, 11)).toEqual({ start: "2026-10-31", end: "2026-11-29" });
  });
  test("a 31-day month ends on the 30th; its start is the previous month's last day", () => {
    expect(payPeriodRange(2026, 7)).toEqual({ start: "2026-06-30", end: "2026-07-30" });
    expect(payPeriodRange(2026, 8)).toEqual({ start: "2026-07-31", end: "2026-08-30" });
  });
  test("December → year end: 30/11–30/12", () => {
    expect(payPeriodRange(2026, 12)).toEqual({ start: "2026-11-30", end: "2026-12-30" });
  });
  test("January crosses the year: the start is 31/12 of the PREVIOUS year", () => {
    expect(payPeriodRange(2027, 1)).toEqual({ start: "2026-12-31", end: "2027-01-30" });
  });
  test("February, common year: 31/1–27/2 · leap year: 31/1–28/2", () => {
    expect(payPeriodRange(2027, 2)).toEqual({ start: "2027-01-31", end: "2027-02-27" });
    expect(payPeriodRange(2028, 2)).toEqual({ start: "2028-01-31", end: "2028-02-28" });
  });
  test("March after a leap February starts on 29/2 · after a common one on 28/2", () => {
    expect(payPeriodRange(2028, 3)).toEqual({ start: "2028-02-29", end: "2028-03-30" });
    expect(payPeriodRange(2027, 3)).toEqual({ start: "2027-02-28", end: "2027-03-30" });
  });
  test("consecutive periods tile with NO gap and NO overlap: the next start = this end + 2 (the last day of the month is the boundary day)", () => {
    // end = last day − 1; the last day itself starts the next period, so the only day outside every period's `end..start` chain is none:
    // period N covers [prevLast, last−1]; period N+1 covers [last, nextLast−1]. So N+1.start = N.end + 1 day.
    for (const [y, m] of [[2026, 9], [2026, 12], [2027, 1], [2027, 2], [2028, 2], [2028, 12]] as const) {
      const a = payPeriodRange(y, m);
      const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
      const b = payPeriodRange(ny, nm);
      const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
      expect(day(b.start) - day(a.end)).toBe(1);
    }
  });
  test("rejects a bad year / month", () => {
    expect(() => payPeriodRange(2026, 0)).toThrow();
    expect(() => payPeriodRange(2026, 13)).toThrow();
    expect(() => payPeriodRange(2026.5, 3)).toThrow();
  });
});

describe("roleOfDay (R1.1: PT+FL is FL Mon–Fri and PT Sat–Sun)", () => {
  // 2026-11-02 is a Monday … 2026-11-08 is a Sunday
  const WEEK = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
  test("the calendar the tests lean on", () => {
    expect(WEEK.map(dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(isWeekend("2026-11-07")).toBe(true);
    expect(isWeekend("2026-11-06")).toBe(false);
  });
  test("PT+FL across a week: FL Mon–Fri, PT Sat and Sun", () => {
    const p = { employmentType: "PT" as const, roles: ["PT", "FL"] as const };
    expect(WEEK.map((d) => roleOfDay(p, d))).toEqual(["FL", "FL", "FL", "FL", "FL", "PT", "PT"]);
  });
  test("it does not matter which of PT / FL is the primary type, nor the order of roles", () => {
    const a = { employmentType: "FL" as const, roles: ["FL", "PT"] as const };
    expect(WEEK.map((d) => roleOfDay(a, d))).toEqual(["FL", "FL", "FL", "FL", "FL", "PT", "PT"]);
  });
  test("every pure type is that type every day of the week", () => {
    for (const t of ["FT", "PT", "FL", "STAFF"] as const) {
      expect(WEEK.map((d) => roleOfDay({ employmentType: t }, d))).toEqual(Array(7).fill(t));
      expect(WEEK.map((d) => roleOfDay({ employmentType: t, roles: [t] }, d))).toEqual(Array(7).fill(t));
    }
  });
  test("empty roles = just employmentType", () => {
    expect(effectiveRoles({ employmentType: "FT", roles: [] })).toEqual(["FT"]);
    expect(roleOfDay({ employmentType: "FT", roles: [] }, "2026-11-07")).toBe("FT");
  });
  test("month and year boundaries use the date itself, never a timezone (Sat 2026-10-31, Sun 2026-11-01, Mon 2026-11-02)", () => {
    const p = { employmentType: "PT" as const, roles: ["PT", "FL"] as const };
    expect(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"].map((d) => roleOfDay(p, d))).toEqual(["FL", "PT", "PT", "FL"]);
    expect(["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"].map((d) => roleOfDay(p, d))).toEqual(["FL", "FL", "PT", "PT", "FL"]);
  });
  test("a malformed date throws", () => {
    expect(() => roleOfDay({ employmentType: "FT" }, "2026-13-40")).toThrow();
    expect(() => roleOfDay({ employmentType: "FT" }, "11/2/2026")).toThrow();
  });
});

describe("rolesProblem (one role, or exactly PT + FL)", () => {
  test("valid", () => {
    expect(rolesProblem({ employmentType: "FT" })).toBeNull();
    expect(rolesProblem({ employmentType: "PT", roles: ["PT", "FL"] })).toBeNull();
    expect(rolesProblem({ employmentType: "FL", roles: ["FL", "PT"] })).toBeNull();
  });
  test("invalid", () => {
    expect(rolesProblem({ employmentType: "FT", roles: ["FT", "PT"] })).not.toBeNull();
    expect(rolesProblem({ employmentType: "STAFF", roles: ["PT", "FL"] })).not.toBeNull();
    expect(rolesProblem({ employmentType: "FT", roles: ["PT"] })).not.toBeNull();
  });
});
