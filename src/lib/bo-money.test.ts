import { describe, expect, test } from "bun:test";
import { computeRemainingAfter, foldPL, movementValueMinor, type PLItemRow } from "./bo-money";

describe("computeRemainingAfter — ceiling guard (TASK-022)", () => {
  test("OUT within the ceiling decrements remaining", () => {
    expect(computeRemainingAfter(100, -2, false)).toEqual({ blocked: false, remainingAfter: 98 });
  });
  test("IN (restock/reversal) increments remaining", () => {
    expect(computeRemainingAfter(98, 2, false)).toEqual({ blocked: false, remainingAfter: 100 });
  });
  test("OUT past zero, no override → blocked (remaining untouched)", () => {
    expect(computeRemainingAfter(1, -2, false)).toEqual({ blocked: true, remainingAfter: 1 });
  });
  test("override allows going negative", () => {
    expect(computeRemainingAfter(1, -2, true)).toEqual({ blocked: false, remainingAfter: -1 });
  });
});

describe("movementValueMinor — signed (OUT positive)", () => {
  test("a sale (qty -2 @ 1500) books +3000", () => {
    expect(movementValueMinor(-2, 1500)).toBe(3000);
  });
  test("a restock/reversal (qty +1 @ 50000) books −50000 (nets out a prior draw)", () => {
    expect(movementValueMinor(1, 50000)).toBe(-50000);
  });
});

describe("foldPL (TASK-022)", () => {
  const W = { from: "2026-07-01", to: "2026-07-31" };
  const rows: PLItemRow[] = [
    { itemId: "water", name: "น้ำ", direction: "INCOME", cadence: "VARIABLE", valueMinor: 3000 },
    { itemId: "salary", name: "เงินเดือน", direction: "EXPENSE", cadence: "FIXED_MONTHLY", valueMinor: 5000000 },
    { itemId: "fl", name: "ฟรีแลนซ์", direction: "EXPENSE", cadence: "FIXED_MONTHLY", valueMinor: 0 }, // netted to 0 → dropped
  ];
  const r = foldPL(rows, W);

  test("income/expense/profit", () => {
    expect(r.incomeMinor).toBe(3000);
    expect(r.expenseMinor).toBe(5000000);
    expect(r.profitMinor).toBe(3000 - 5000000);
  });
  test("byItem drops zero-net items", () => {
    expect(r.byItem.map((i) => i.itemId)).toEqual(["water", "salary"]);
  });
  test("byDirection + byCadence aggregate", () => {
    expect(r.byDirection).toEqual(
      expect.arrayContaining([
        { direction: "INCOME", valueMinor: 3000 },
        { direction: "EXPENSE", valueMinor: 5000000 },
      ]),
    );
    expect(r.byCadence).toEqual(
      expect.arrayContaining([
        { direction: "EXPENSE", cadence: "FIXED_MONTHLY", valueMinor: 5000000 },
      ]),
    );
  });
});
