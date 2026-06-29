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
} from "../types/contract";

const DEFAULT_ORG_CODE = "default";

export async function resolveOrganization(orgCode = DEFAULT_ORG_CODE) {
  const row = await db.query.organizations.findFirst({
    where: eq(organizations.code, orgCode),
  });
  if (!row) throw notFound(`organization '${orgCode}' ไม่พบ — รัน db:seed`);
  return row;
}

export async function listCatalogItems(orgCode?: string) {
  const org = await resolveOrganization(orgCode);
  const rows = await db.query.catalogItems.findMany({
    where: and(eq(catalogItems.organizationId, org.id), eq(catalogItems.active, true)),
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
        salePriceMinor: input.salePriceMinor ?? 0,
        trackStock: input.trackStock ?? true,
        reorderLevel: input.reorderLevel ?? null,
      })
      .returning();
    await tx.insert(stockBalances).values({ itemId: item.id, quantityOnHand: 0 });
    return toCatalogItemDTO(item, { itemId: item.id, quantityOnHand: 0, updatedAt: new Date() });
  });
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

export async function applyStockMovement(itemId: string, input: StockMovementRequest) {
  assertPositiveInt(input.quantity, "quantity");

  const existing = await findMovementByIdempotency(input.idempotencyKey);
  if (existing) return toStockMovementDTO(existing);

  return await db.transaction(async (tx) => {
    const item = await tx.query.catalogItems.findFirst({
      where: eq(catalogItems.id, itemId),
    });
    if (!item) throw notFound("ไม่พบสินค้า");
    if (!item.trackStock && input.direction !== "IN") {
      throw badRequest("สินค้านี้ไม่ track stock");
    }

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

    const nextQty = balance.quantityOnHand + delta;
    if (nextQty < 0) throw conflict("INSUFFICIENT_STOCK", "สต๊อกไม่พอ");

    await tx
      .update(stockBalances)
      .set({ quantityOnHand: nextQty })
      .where(eq(stockBalances.itemId, itemId));

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        itemId,
        direction: input.direction,
        quantity: input.quantity,
        quantityAfter: nextQty,
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
