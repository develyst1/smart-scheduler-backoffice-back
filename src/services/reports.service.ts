// Profit & Loss report (item-centric). Income/cost/profit roll up from the baht value
// of stock movements: an OUT movement of an INCOME item is revenue; an OUT movement of
// an EXPENSE or FIXED_COST item is a cost. IN movements (restock) are P&L-neutral.

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { catalogItems, stockMovements } from "../db/schema";
import { resolveOrganization } from "./inventory.service";
import type { ItemType, PLReport, PLReportQuery } from "../types/contract";

function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: first.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

export async function getPLReport(query: PLReportQuery): Promise<PLReport> {
  const org = await resolveOrganization(query.orgCode);
  const def = currentMonthRange();
  const from = query.from ?? def.from;
  const to = query.to ?? def.to;

  const rows = await db
    .select({
      itemId: catalogItems.id,
      sku: catalogItems.sku,
      name: catalogItems.name,
      itemGroup: catalogItems.itemGroup,
      itemType: catalogItems.itemType,
      amountMinor: sql<number>`coalesce(sum(${stockMovements.amountMinor}), 0)::int`,
    })
    .from(stockMovements)
    .innerJoin(catalogItems, eq(catalogItems.id, stockMovements.itemId))
    .where(
      and(
        eq(catalogItems.organizationId, org.id),
        eq(stockMovements.direction, "OUT"),
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

  const byItem = rows.filter((r) => r.amountMinor !== 0);

  let revenueMinor = 0;
  let costMinor = 0;
  const typeAgg = new Map<ItemType, number>();
  for (const r of byItem) {
    typeAgg.set(r.itemType, (typeAgg.get(r.itemType) ?? 0) + r.amountMinor);
    if (r.itemType === "INCOME") revenueMinor += r.amountMinor;
    else costMinor += r.amountMinor;
  }

  return {
    from,
    to,
    revenueMinor,
    costMinor,
    profitMinor: revenueMinor - costMinor,
    byType: [...typeAgg.entries()].map(([itemType, amountMinor]) => ({ itemType, amountMinor })),
    byItem,
  };
}
