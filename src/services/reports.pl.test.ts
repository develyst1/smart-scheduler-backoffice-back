import { describe, expect, test } from "bun:test";
import { foldPLRows, type PLItemRow } from "./reports.service";

const W = { from: "2026-07-01", to: "2026-07-31" };

function row(p: Partial<PLItemRow> & Pick<PLItemRow, "itemType">): PLItemRow {
  return {
    itemId: p.itemId ?? "i1",
    sku: p.sku ?? "SKU1",
    name: p.name ?? "Item",
    itemGroup: p.itemGroup ?? "SERVICE",
    itemType: p.itemType,
    outMinor: p.outMinor ?? 0,
    reversalMinor: p.reversalMinor ?? 0,
  };
}

describe("foldPLRows — reversible freelance expense (SPEC-001)", () => {
  test("OUT 1,500 then reversal IN 1,500 → 0 expense, item drops out", () => {
    const r = foldPLRows([row({ itemType: "EXPENSE", outMinor: 1500, reversalMinor: 1500 })], W);
    expect(r.costMinor).toBe(0);
    expect(r.byItem).toHaveLength(0);
  });

  test("OUT 1,500 only → 1,500 expense", () => {
    const r = foldPLRows([row({ itemType: "EXPENSE", outMinor: 1500 })], W);
    expect(r.costMinor).toBe(1500);
    expect(r.byItem[0]?.amountMinor).toBe(1500);
  });

  test("partial reversal: OUT 3,000 − reversal 1,000 → 2,000 net expense", () => {
    const r = foldPLRows([row({ itemType: "EXPENSE", outMinor: 3000, reversalMinor: 1000 })], W);
    expect(r.costMinor).toBe(2000);
  });

  test("top-up / reset are amountMinor=0 → no P&L effect (outMinor=0)", () => {
    // top-ups (IN, amount 0) and resets (ADJUST, amount 0) never contribute OUT value.
    const r = foldPLRows([row({ itemType: "EXPENSE", outMinor: 0, reversalMinor: 0 })], W);
    expect(r.costMinor).toBe(0);
    expect(r.byItem).toHaveLength(0);
  });

  test("INCOME and FIXED_COST are unaffected by reversal logic (ΣOUT)", () => {
    const r = foldPLRows(
      [
        row({ itemId: "inc", itemType: "INCOME", outMinor: 5000 }),
        row({ itemId: "fix", itemType: "FIXED_COST", outMinor: 2000 }),
        row({ itemId: "fl", itemType: "EXPENSE", outMinor: 1500, reversalMinor: 1500 }),
      ],
      W,
    );
    expect(r.revenueMinor).toBe(5000);
    expect(r.costMinor).toBe(2000); // fixed cost only; freelance netted to 0
    expect(r.profitMinor).toBe(3000);
    expect(r.byType).toEqual(
      expect.arrayContaining([
        { itemType: "INCOME", amountMinor: 5000 },
        { itemType: "FIXED_COST", amountMinor: 2000 },
      ]),
    );
  });
});
