// Universal-item money math (SPEC-006 / TASK-022) — pure, so ceiling + P&L logic is unit-testable.
// All money in integer satang. `qty` is signed: negative = OUT (a sale / a draw), positive = IN
// (restock / reversal).

/** Apply a signed qty to a ceiling-tracked remaining. Blocked when it would go < 0 and no override. */
export function computeRemainingAfter(
  remaining: number,
  qty: number,
  allowNegative: boolean,
): { blocked: boolean; remainingAfter: number } {
  const next = remaining + qty;
  if (next < 0 && !allowNegative) return { blocked: true, remainingAfter: remaining };
  return { blocked: false, remainingAfter: next };
}

/** Signed P&L value of a movement: **`−qty × unit_price`** so an OUT (qty<0) is a positive figure and an
 *  IN/reversal (qty>0) is negative → `SUM(value_minor)` nets sales-vs-returns and draws-vs-reversals. */
export const movementValueMinor = (qty: number, unitPriceMinor: number) => -qty * unitPriceMinor;

export type Direction = "INCOME" | "EXPENSE";

export interface PLItemRow {
  itemId: string;
  name: string;
  direction: Direction;
  cadence: string;
  valueMinor: number; // net SUM(value_minor) for the item in the window
}

export interface PLReport {
  from: string;
  to: string;
  incomeMinor: number;
  expenseMinor: number;
  profitMinor: number;
  byDirection: { direction: Direction; valueMinor: number }[];
  byCadence: { direction: Direction; cadence: string; valueMinor: number }[];
  byItem: PLItemRow[];
}

/** Pure P&L roll-up: income = Σ INCOME items, expense = Σ EXPENSE items, profit = income − expense. */
export function foldPL(rows: PLItemRow[], window: { from: string; to: string }): PLReport {
  let incomeMinor = 0;
  let expenseMinor = 0;
  const dir = new Map<Direction, number>();
  const cad = new Map<string, number>();
  const byItem = rows.filter((r) => r.valueMinor !== 0);

  for (const r of byItem) {
    if (r.direction === "INCOME") incomeMinor += r.valueMinor;
    else expenseMinor += r.valueMinor;
    dir.set(r.direction, (dir.get(r.direction) ?? 0) + r.valueMinor);
    const key = `${r.direction}|${r.cadence}`;
    cad.set(key, (cad.get(key) ?? 0) + r.valueMinor);
  }

  return {
    from: window.from,
    to: window.to,
    incomeMinor,
    expenseMinor,
    profitMinor: incomeMinor - expenseMinor,
    byDirection: [...dir.entries()].map(([direction, valueMinor]) => ({ direction, valueMinor })),
    byCadence: [...cad.entries()].map(([k, valueMinor]) => {
      const [direction, cadence] = k.split("|");
      return { direction: direction as Direction, cadence, valueMinor };
    }),
    byItem,
  };
}
