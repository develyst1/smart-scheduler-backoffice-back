// Profit & Loss report (item-centric). Income/cost/profit roll up from the baht value
// of stock movements: an OUT movement of an INCOME item is revenue; an OUT movement of
// an EXPENSE or FIXED_COST item is a cost. IN movements (restock) are P&L-neutral.

import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { catalogItems, stockMovements } from "../db/schema";
import { resolveOrganization } from "./inventory.service";
import type { ItemType, PLByItem, PLReport, PLReportQuery } from "../types/contract";

function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: first.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

/** Per-item raw sums pulled from the DB: gross OUT value and the reversal-IN value
 *  to subtract from it (SPEC-001 reversible freelance expense). */
export interface PLItemRow {
  itemId: string;
  sku: string;
  name: string;
  itemGroup: PLByItem["itemGroup"];
  itemType: ItemType;
  outMinor: number;
  reversalMinor: number;
}

/** Pure P&L roll-up (no DB) — kept separate so the reversal netting is unit-testable.
 *  Per item, amount = ΣOUT − Σ(reversal IN). INCOME → revenue, EXPENSE/FIXED_COST → cost.
 *  Top-ups/resets carry amountMinor=0 so they never reach here with a value; a fully
 *  reversed item nets 0 and drops out of byItem. */
export function foldPLRows(
  rows: PLItemRow[],
  window: { from: string; to: string },
): PLReport {
  const byItem: PLByItem[] = rows
    .map((r) => ({
      itemId: r.itemId,
      sku: r.sku,
      name: r.name,
      itemGroup: r.itemGroup,
      itemType: r.itemType,
      amountMinor: r.outMinor - r.reversalMinor,
    }))
    .filter((r) => r.amountMinor !== 0);

  let revenueMinor = 0;
  let costMinor = 0;
  const typeAgg = new Map<ItemType, number>();
  for (const r of byItem) {
    typeAgg.set(r.itemType, (typeAgg.get(r.itemType) ?? 0) + r.amountMinor);
    if (r.itemType === "INCOME") revenueMinor += r.amountMinor;
    else costMinor += r.amountMinor;
  }

  return {
    from: window.from,
    to: window.to,
    revenueMinor,
    costMinor,
    profitMinor: revenueMinor - costMinor,
    byType: [...typeAgg.entries()].map(([itemType, amountMinor]) => ({ itemType, amountMinor })),
    byItem,
  };
}

export async function getPLReport(query: PLReportQuery): Promise<PLReport> {
  const org = await resolveOrganization(query.orgCode);
  const def = currentMonthRange();
  const from = query.from ?? def.from;
  const to = query.to ?? def.to;

  // Pull OUT movements (revenue/cost) plus reversal INs (BOOKING_REVERSAL) so the fold
  // can net freelance expense = ΣOUT − Σ(reversal IN). Other INs (restock/top-up) stay out.
  const rows = await db
    .select({
      itemId: catalogItems.id,
      sku: catalogItems.sku,
      name: catalogItems.name,
      itemGroup: catalogItems.itemGroup,
      itemType: catalogItems.itemType,
      outMinor: sql<number>`coalesce(sum(${stockMovements.amountMinor}) filter (where ${stockMovements.direction} = 'OUT'), 0)::int`,
      reversalMinor: sql<number>`coalesce(sum(${stockMovements.amountMinor}) filter (where ${stockMovements.direction} = 'IN' and ${stockMovements.refType} = 'BOOKING_REVERSAL'), 0)::int`,
    })
    .from(stockMovements)
    .innerJoin(catalogItems, eq(catalogItems.id, stockMovements.itemId))
    .where(
      and(
        eq(catalogItems.organizationId, org.id),
        or(
          eq(stockMovements.direction, "OUT"),
          and(
            eq(stockMovements.direction, "IN"),
            eq(stockMovements.refType, "BOOKING_REVERSAL"),
          ),
        ),
        gte(stockMovements.createdAt, sql`${from}::date`),
        lt(stockMovements.createdAt, sql`(${to}::date + 1)`), // `to` inclusive
      ),
    )
    .groupBy(
      catalogItems.id,
      catalogItems.sku,
      catalogItems.name,
      catalogItems.itemGroup,
      catalogItems.itemType,
    );

  return foldPLRows(rows, { from, to });
}
