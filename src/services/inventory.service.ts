import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { toCatalogItemDTO, toStockMovementDTO } from "../db/mappers";
import {
  catalogItems,
  organizations,
  stockBalances,
  stockMovements,
} from "../db/schema";
import { assertPositiveInt } from "../lib/money";
import { badRequest, conflict, notFound } from "../lib/http";
import type {
  CreateCatalogItemRequest,
  CreateSaleRequest,
  StockMovementRequest,
  UpdateCatalogItemRequest,
} from "../types/contract";

const DEFAULT_ORG_CODE = "default";

export async function resolveOrganization(orgCode = DEFAULT_ORG_CODE) {
  const row = await db.query.organizations.findFirst({
    where: eq(organizations.code, orgCode),
  });
  if (!row) throw notFound(`organization '${orgCode}' ไม่พบ — รัน db:seed`);
  return row;
}

export async function listCatalogItems(filter: {
  orgCode?: string;
  externalSource?: string;
  externalRef?: string;
  itemType?: "INCOME" | "EXPENSE" | "FIXED_COST";
} = {}) {
  const org = await resolveOrganization(filter.orgCode);
  const conds = [eq(catalogItems.organizationId, org.id), eq(catalogItems.active, true)];
  if (filter.externalSource) conds.push(eq(catalogItems.externalSource, filter.externalSource));
  if (filter.externalRef) conds.push(eq(catalogItems.externalRef, filter.externalRef));
  if (filter.itemType) conds.push(eq(catalogItems.itemType, filter.itemType));
  const rows = await db.query.catalogItems.findMany({
    where: and(...conds),
    with: { balance: true },
    orderBy: (t, { asc }) => asc(t.name),
  });
  return rows.map((r) => toCatalogItemDTO(r, r.balance));
}

export async function createCatalogItem(input: CreateCatalogItemRequest, orgCode?: string) {
  const org = await resolveOrganization(orgCode);
  return await db.transaction(async (tx) => {
    const [item] = await tx
      .insert(catalogItems)
      .values({
        organizationId: org.id,
        sku: input.sku,
        name: input.name,
        unit: input.unit ?? "each",
        itemGroup: input.itemGroup ?? "PRODUCT",
        itemType: input.itemType ?? "INCOME",
        salePriceMinor: input.salePriceMinor ?? 0,
        trackStock: input.trackStock ?? true,
        reorderLevel: input.reorderLevel ?? null,
        externalRef: input.externalRef ?? null,
        externalSource: input.externalSource ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();
    await tx.insert(stockBalances).values({ itemId: item.id, quantityOnHand: 0 });
    return toCatalogItemDTO(item, { itemId: item.id, quantityOnHand: 0, updatedAt: new Date() });
  });
}

/** Apply a movement to the item linked to (externalSource, externalRef) — for consumers
 *  (e.g. scheduling) that reference items by upstream id, not uuid. */
export async function applyStockMovementByExternal(
  externalSource: string,
  externalRef: string,
  input: StockMovementRequest,
  orgCode?: string,
) {
  const org = await resolveOrganization(orgCode);
  const item = await db.query.catalogItems.findFirst({
    where: and(
      eq(catalogItems.organizationId, org.id),
      eq(catalogItems.externalSource, externalSource),
      eq(catalogItems.externalRef, externalRef),
    ),
  });
  if (!item) throw notFound(`ไม่พบ item ที่ผูกกับ ${externalSource}:${externalRef}`);
  return applyStockMovement(item.id, input);
}

/** Shallow-merge incoming metadata into existing (TASK-009) so editing one key (e.g.
 *  monthlyBudgetMinor) preserves the rest (e.g. kind). `undefined` incoming = leave as-is. */
export function mergeMetadata(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (incoming === undefined) return existing ?? null;
  return { ...(existing ?? {}), ...incoming };
}

/** Partial update of a catalog item (TASK-009). Only name/salePriceMinor/reorderLevel/active/metadata
 *  are editable; sku/group/type/external_* stay fixed. Editing metadata.monthlyBudgetMinor does NOT
 *  change current stock — the new budget takes effect at the next monthly reset (TASK-005). */
export async function updateCatalogItem(id: string, input: UpdateCatalogItemRequest) {
  const existing = await db.query.catalogItems.findFirst({ where: eq(catalogItems.id, id) });
  if (!existing) throw notFound("ไม่พบสินค้า");

  const patch: Partial<typeof catalogItems.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.salePriceMinor !== undefined) patch.salePriceMinor = input.salePriceMinor;
  if (input.reorderLevel !== undefined) patch.reorderLevel = input.reorderLevel;
  if (input.active !== undefined) patch.active = input.active;
  if (input.metadata !== undefined) patch.metadata = mergeMetadata(existing.metadata, input.metadata);

  const item =
    Object.keys(patch).length === 0
      ? existing
      : (await db.update(catalogItems).set(patch).where(eq(catalogItems.id, id)).returning())[0];

  const balance = await db.query.stockBalances.findFirst({ where: eq(stockBalances.itemId, id) });
  return toCatalogItemDTO(item, balance);
}

export async function getCatalogItem(id: string) {
  const row = await db.query.catalogItems.findFirst({
    where: eq(catalogItems.id, id),
    with: { balance: true },
  });
  if (!row) throw notFound("ไม่พบสินค้า");
  return toCatalogItemDTO(row, row.balance);
}

async function findMovementByIdempotency(key: string | undefined) {
  if (!key) return null;
  return db.query.stockMovements.findFirst({
    where: eq(stockMovements.idempotencyKey, key),
  });
}

// Movement conventions for freelance budget-stock items (SPEC-001 / TASK-002).
// The scheduling caller sends, per event:
//   booking committed  → OUT, amountMinor=job satang, refType='BOOKING'
//   cancel/customer-leave → IN,  amountMinor=job satang, refType='BOOKING_REVERSAL'
//   admin top-up (unlock) → IN,  amountMinor=0,          refType='TOPUP'
//   monthly reset       → ADJUST reason='=<budget>', amountMinor=0, refType='RESET'
// The P&L (reports.service) nets EXPENSE = ΣOUT − Σ(reversal IN); amountMinor=0 movements
// (top-up/reset) are P&L-neutral. `allowNegative` lets the capping-day overage / admin
// unlock drive quantity_on_hand ≤ 0.
export async function applyStockMovement(itemId: string, input: StockMovementRequest) {
  assertPositiveInt(input.quantity, "quantity");

  const existing = await findMovementByIdempotency(input.idempotencyKey);
  if (existing) return toStockMovementDTO(existing);

  return await db.transaction(async (tx) => {
    const item = await tx.query.catalogItems.findFirst({
      where: eq(catalogItems.id, itemId),
    });
    if (!item) throw notFound("ไม่พบสินค้า");
    // P&L value of this movement: explicit if given, else quantity × the item's unit amount.
    const amountMinor = input.amountMinor ?? input.quantity * item.salePriceMinor;

    let nextQty = 0;
    if (item.trackStock) {
      // Stock-tracked item (products, teacher quota): mutate the balance with a guard.
      let balance = await tx.query.stockBalances.findFirst({
        where: eq(stockBalances.itemId, itemId),
      });
      if (!balance) {
        const [created] = await tx
          .insert(stockBalances)
          .values({ itemId, quantityOnHand: 0 })
          .returning();
        balance = created;
      }

      let delta = input.quantity;
      if (input.direction === "OUT") delta = -input.quantity;
      if (input.direction === "ADJUST") {
        // ADJUST sets absolute target when reason starts with '=' e.g. '=50'
        if (input.reason?.startsWith("=")) {
          const target = Number(input.reason.slice(1));
          if (!Number.isInteger(target) || target < 0) throw badRequest("ADJUST target ไม่ถูกต้อง");
          delta = target - balance.quantityOnHand;
        }
      }

      nextQty = balance.quantityOnHand + delta;
      if (nextQty < 0 && !input.allowNegative) throw conflict("INSUFFICIENT_STOCK", "สต๊อกไม่พอ");

      await tx
        .update(stockBalances)
        .set({ quantityOnHand: nextQty })
        .where(eq(stockBalances.itemId, itemId));
    } else {
      // Non-stock item (e.g. an unlimited INCOME service or a FIXED_COST): record the
      // movement for the P&L only — there is no balance to draw down.
      const balance = await tx.query.stockBalances.findFirst({
        where: eq(stockBalances.itemId, itemId),
      });
      nextQty = balance?.quantityOnHand ?? 0;
    }

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        itemId,
        direction: input.direction,
        quantity: input.quantity,
        quantityAfter: nextQty,
        amountMinor,
        reason: input.reason ?? null,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();

    return toStockMovementDTO(movement);
  });
}

export async function listStockMovements(itemId: string, limit: number) {
  const rows = await db.query.stockMovements.findMany({
    where: eq(stockMovements.itemId, itemId),
    orderBy: [desc(stockMovements.createdAt)],
    limit,
  });
  return rows.map(toStockMovementDTO);
}

export async function createSale(input: CreateSaleRequest, orgCode?: string) {
  await resolveOrganization(orgCode);

  if (input.idempotencyKey) {
    const dup = await findMovementByIdempotency(input.idempotencyKey);
    if (dup) {
      const all = await db.query.stockMovements.findMany({
        where: eq(stockMovements.refId, input.idempotencyKey),
      });
      if (all.length) {
        const totalMinor = await sumSaleTotal(input.lines);
        return { movements: all.map(toStockMovementDTO), totalMinor };
      }
    }
  }

  const movements = [];
  let totalMinor = 0;

  for (const line of input.lines) {
    const item = await getCatalogItem(line.itemId);
    totalMinor += item.salePriceMinor * line.quantity;
    const mv = await applyStockMovement(line.itemId, {
      direction: "OUT",
      quantity: line.quantity,
      reason: "POS sale",
      refType: input.refType ?? "SALE",
      refId: input.refId ?? input.idempotencyKey,
      idempotencyKey: input.idempotencyKey
        ? `${input.idempotencyKey}:${line.itemId}`
        : undefined,
    });
    movements.push(mv);
  }

  return { movements, totalMinor };
}

async function sumSaleTotal(lines: CreateSaleRequest["lines"]) {
  let total = 0;
  for (const line of lines) {
    const item = await getCatalogItem(line.itemId);
    total += item.salePriceMinor * line.quantity;
  }
  return total;
}
