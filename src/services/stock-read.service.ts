// TASK-904 — the Stock FOUNDATION reads (the picker of TASK-905 and the Movement report of TASK-906 sit on these two).
//   GET /v1/stock/products                        → [{ id, code, name, category, priceSatang, quantity, commissionGroup, active }]   (?q= server search)
//   GET /v1/bo/stock/movements?from&to&type&q&limit → { items: [{ id, occurredOn, itemId, itemName, type, qty, remainingAfter }] }
// NO location (deferred — one location now) and, on the movement report, NO money: the screen shows no amounts, so the response has no `valueMinor`.
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { boItem, boItemTag, boMovement, boSale, boSaleLine, boTagGroup, boTagValue } from "../db/schema";
import { badRequest } from "../lib/http";
import { boRevenueCategory } from "../db/schema-revenue";
import { CATEGORY_GROUP, STOCK_SOURCE } from "../lib/stock-import";
import { MOVEMENT_TYPES, bangkokDayBounds, daysBetween, escapeLike, movementTypeOf, type MovementType } from "../lib/stock-read";

export async function listProducts(q?: string) {
  const term = q?.trim();
  const rows = await db
    .select()
    .from(boItem)
    .where(
      and(
        eq(boItem.externalSource, STOCK_SOURCE),
        term ? or(ilike(boItem.name, `%${escapeLike(term)}%`), ilike(boItem.externalRef, `%${escapeLike(term)}%`)) : undefined,
      ),
    )
    .orderBy(asc(boItem.externalRef));
  const cats = rows.length
    ? await db
        .select({ itemId: boItemTag.itemId, label: boTagValue.label })
        .from(boItemTag)
        .innerJoin(boTagGroup, eq(boTagGroup.id, boItemTag.tagGroupId))
        .innerJoin(boTagValue, eq(boTagValue.id, boItemTag.tagValueId))
        .where(and(eq(boTagGroup.name, CATEGORY_GROUP), inArray(boItemTag.itemId, rows.map((r) => r.id))))
    : [];
  const catOf = new Map(cats.map((c) => [c.itemId, c.label]));
  return rows.map((r) => ({
    id: r.id,
    code: r.externalRef ?? "",
    name: r.name,
    category: catOf.get(r.id) ?? null,
    priceSatang: r.unitPriceMinor,
    quantity: r.remainingQty,
    commissionGroup: r.commissionGroup ? { name: r.commissionGroup, amountSatang: null as number | null } : null,
    active: r.active,
  }));
}

/** 🔻 TASK-911 - a movement's day: its business date, else the Bangkok calendar day of `created_at` (legacy rows). YYYY-MM-DD, so it compares as text. */
const DAY_OF_MOVEMENT = sql`coalesce(to_char(${boMovement.occurredOn}, 'YYYY-MM-DD'), to_char(${boMovement.createdAt} at time zone 'Asia/Bangkok', 'YYYY-MM-DD'))`;

/** 🔻 TASK-909 (Sector's ruling): the product form's picker — active revenue categories of the PRODUCT types (SALES / FNB / RENT / OTHER): names, no money, no new permission. */
export async function listRevenueCategories() {
  const rows = await db
    .select({ id: boRevenueCategory.id, type: boRevenueCategory.type, name: boRevenueCategory.name })
    .from(boRevenueCategory)
    .where(and(eq(boRevenueCategory.active, true), inArray(boRevenueCategory.type, ["SALES", "FNB", "RENT", "OTHER"])))
    .orderBy(asc(boRevenueCategory.type), asc(boRevenueCategory.sortOrder));
  return { categories: rows };
}

export interface MovementQuery { from: string; to: string; type?: MovementType; q?: string; limit: number }

export async function listStockMovements(query: MovementQuery, exec: typeof db = db) {
  const span = daysBetween(query.from, query.to);
  if (span === null) throw badRequest("from / to ต้องเป็นวันที่ YYYY-MM-DD ที่มีจริง");
  if (span < 0) throw badRequest("from ต้องไม่เกิน to");
  if (span > 365) throw badRequest("ช่วงวันที่ต้องไม่เกิน 366 วัน");
  const term = query.q?.trim();
  const rows = await exec
    .select({
      id: boMovement.id, createdAt: boMovement.createdAt, itemId: boMovement.itemId, itemName: boItem.name, code: boItem.externalRef,
      qty: boMovement.qty, remainingAfter: boMovement.remainingAfter, refType: boMovement.refType,
      day: sql<string>`${DAY_OF_MOVEMENT}`, // 🔻 TASK-911: the business day (occurred_on), else the Bangkok day of created_at for a legacy row
    })
    .from(boMovement)
    .innerJoin(boItem, eq(boItem.id, boMovement.itemId))
    .where(
      and(
        eq(boItem.externalSource, STOCK_SOURCE), // stock products only — not freelance ceilings, not sale-posting items
        sql`${DAY_OF_MOVEMENT} >= ${query.from} and ${DAY_OF_MOVEMENT} <= ${query.to}`,
        term ? or(ilike(boItem.name, `%${escapeLike(term)}%`), ilike(boItem.externalRef, `%${escapeLike(term)}%`)) : undefined,
      ),
    )
    .orderBy(desc(sql`${DAY_OF_MOVEMENT}`), desc(boMovement.createdAt))
    .limit(query.type ? 5000 : query.limit); // the type is derived in code, so a type filter reads wider and cuts after
  const items = rows
    .map((r) => ({ id: r.id, occurredOn: r.day, itemId: r.itemId, itemName: r.itemName, type: movementTypeOf({ qty: r.qty, refType: r.refType }), qty: r.qty, remainingAfter: r.remainingAfter }))
    .filter((r) => !query.type || r.type === query.type)
    .slice(0, query.limit);
  return { items };
}

// 🔻 TASK-928 (R3.8) — the Sales History read. The final UI's tab (StockReport.tsx) shows Date · Product · Qty · Customer · Payment and «No revenue amounts here»: so this read carries NO money at all
// (no price, discount, commission or amount — an admin and the CEO see the same rows, and there is no total to gate). Customer = the sale's buyer; Payment = the sale's method.
export interface SalesQuery { from: string; to: string; q?: string; customer?: string; limit: number }
export const SALES_LIMIT_MAX = 1000;

const SALE_DAY = sql`to_char(${boSale.soldAt} at time zone 'Asia/Bangkok', 'YYYY-MM-DD')`;

export async function listSales(query: SalesQuery, exec: typeof db = db) {
  const span = daysBetween(query.from, query.to);
  if (span === null) throw badRequest("from / to ต้องเป็นวันที่ YYYY-MM-DD ที่มีจริง");
  if (span < 0) throw badRequest("from ต้องไม่เกิน to");
  if (span > 365) throw badRequest("ช่วงวันที่ต้องไม่เกิน 366 วัน");
  const term = query.q?.trim();
  const customer = query.customer?.trim();
  const inWindow = and(
    eq(boItem.externalSource, STOCK_SOURCE), // stock products only
    sql`${SALE_DAY} >= ${query.from} and ${SALE_DAY} <= ${query.to}`,
  );
  const rows = await exec
    .select({
      id: boSaleLine.id, saleId: boSale.id, day: sql<string>`${SALE_DAY}`, itemId: boItem.id, code: boItem.externalRef, name: boItem.name,
      qty: boSaleLine.qty, buyer: boSale.buyerRef, method: boSale.method, branch: boSale.branch,
    })
    .from(boSaleLine)
    .innerJoin(boSale, eq(boSale.id, boSaleLine.saleId))
    .innerJoin(boItem, eq(boItem.id, boSaleLine.itemId))
    .where(
      and(
        inWindow,
        term ? or(ilike(boItem.name, `%${escapeLike(term)}%`), ilike(boItem.externalRef, `%${escapeLike(term)}%`), ilike(boSale.buyerRef, `%${escapeLike(term)}%`)) : undefined,
        customer ? eq(boSale.buyerRef, customer) : undefined,
      ),
    )
    .orderBy(desc(boSale.soldAt), desc(boSaleLine.id))
    .limit(query.limit);
  // the Customer select's options: every distinct buyer named in the WINDOW (not only on the page), so choosing one never needs a second guess
  const buyers = await exec
    .selectDistinct({ buyer: boSale.buyerRef })
    .from(boSaleLine)
    .innerJoin(boSale, eq(boSale.id, boSaleLine.saleId))
    .innerJoin(boItem, eq(boItem.id, boSaleLine.itemId))
    .where(and(inWindow, sql`${boSale.buyerRef} is not null and btrim(${boSale.buyerRef}) <> ''`))
    .orderBy(asc(boSale.buyerRef))
    .limit(200);
  return {
    items: rows.map((r) => ({ id: r.id, saleId: r.saleId, occurredOn: r.day, itemId: r.itemId, code: r.code ?? "", name: r.name, qty: r.qty, customer: r.buyer, payment: r.method, branch: r.branch })),
    customers: buyers.map((b) => b.buyer as string),
  };
}

export { MOVEMENT_TYPES };
