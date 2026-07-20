import { describe, expect, test } from "bun:test";
import { coversMonth, isMonth, monthFirstDay, prevMonthFirstDay } from "./month";

describe("month helpers (SPEC-002)", () => {
  test("isMonth validates YYYY-MM", () => {
    expect(isMonth("2026-07")).toBe(true);
    expect(isMonth("2026-7")).toBe(false);
    expect(isMonth("2026-07-01")).toBe(false);
  });

  test("monthFirstDay", () => {
    expect(monthFirstDay("2026-07")).toBe("2026-07-01");
  });

  test("prevMonthFirstDay handles the Jan → Dec year rollover", () => {
    expect(prevMonthFirstDay("2026-07")).toBe("2026-06-01");
    expect(prevMonthFirstDay("2026-01")).toBe("2025-12-01");
  });
});

describe("coversMonth — effective-dated selection (SPEC-002 historical correctness)", () => {
  // Salary set 2026-01 @ X, then changed effective 2026-06 @ Y:
  //   old row: from 2026-01-01 → 2026-05-01 (closed the month before the change)
  //   new row: from 2026-06-01 → open
  const oldRow = { effectiveFrom: "2026-01-01", effectiveTo: "2026-05-01" };
  const newRow = { effectiveFrom: "2026-06-01", effectiveTo: null };

  test("a past month resolves to the row in effect THEN, not the latest", () => {
    expect(coversMonth(oldRow, "2026-03")).toBe(true); // March → old amount
    expect(coversMonth(newRow, "2026-03")).toBe(false);
  });

  test("the change month onward resolves to the new row", () => {
    expect(coversMonth(newRow, "2026-06")).toBe(true);
    expect(coversMonth(oldRow, "2026-06")).toBe(false);
    expect(coversMonth(newRow, "2027-01")).toBe(true); // open-ended covers the future
  });

  test("boundary months are inclusive on both ends", () => {
    expect(coversMonth(oldRow, "2026-01")).toBe(true); // effective_from month
    expect(coversMonth(oldRow, "2026-05")).toBe(true); // effective_to month
    expect(coversMonth(oldRow, "2025-12")).toBe(false); // before it started
  });
});
