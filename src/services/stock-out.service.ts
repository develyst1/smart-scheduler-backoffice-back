// TASK-909 (REQ-120 R3.5) — Stock OUT: a cart → ONE SALE movement per line (−qty, the balance decremented) + a sale record, all in ONE transaction.
//
//   • reuses 904's rule and refusal: a line that would take a balance below zero refuses the WHOLE sale with `NEGATIVE_BALANCE` (`refuseIfNegative`, the same function the
//     import's apply uses; the route turns it into the same body) — nothing is written, no balance moves;
//   • the products are locked `FOR UPDATE` (in id order, so two carts cannot deadlock) BEFORE the idempotency check, so two posts of one cart run one at a time and the
//     second sees the first;
//   • idempotent on the client's `idempotencyKey`: a re-POST writes nothing and returns the FIRST result with `alreadyApplied: true`;
//   • the movement key is `stock-out:<saleId>:<itemId>`; `ref_type = 'SALE'`, `ref_id = <saleId>` — the movement report shows it as type SALE;
//   • money is integer satang, stored AS GIVEN: `unitPriceSatang`, `discountSatang` (off the LINE total), `commissionSatang` (no rate, no split, no pool — that is a later layer).
//     The movement's `value_minor` is 0 (Sober, 2026-11-09): the movement is INVENTORY truth only, like the import's; the money lives in `sale_line`, so a stock sale is never shadow-posted into the legacy bo P&L (and cannot double-count once revenue posts);
//   • the response carries NO totals (an admin sees none): { saleId, movementsWritten, soldAt, alreadyApplied? }.
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { boItem, boMovement, boSale, boSaleLine } from "../db/schema";
import { ApiException, badRequest, pgErrorCode } from "../lib/http";
import { STOCK_SOURCE, StockImportRefusal, refuseIfNegative } from "../lib/stock-import";
import { bangkokDate } from "../lib/stock-read";
import { postSaleLineRevenue } from "./sale-line-revenue.service"; // 🔻 TASK-909

export interface CartLine { itemId: string; qty: number; unitPriceSatang: number; discountSatang?: number; commissionSatang?: number }
export interface Cart {
  idempotencyKey: string;
  soldAt?: string;
  sellerRefs?: string[];
  branch?: "BRAVO" | "OTHER";
  method?: "TRANSFER" | "CASH" | "CARD";
  buyerRef?: string;
  remark?: string;
  lines: CartLine[];
}
export interface StockOutResult { saleId: string; movementsWritten: number; soldAt: string; alreadyApplied?: true }

export interface LockedItem { id: string; model: string; name: string; qty: number | null; active: boolean; /** 🔻 TASK-909 (row 21): where a sale of this product posts its revenue; null ⇒ the sale is refused (NO_REVENUE_CATEGORY) */ revenueCategoryId?: string | null }
export interface ExistingSale { id: string; soldAt: string; lines: number }
export interface StockOutTx {
  /** The cart's items (stock products only), locked FOR UPDATE in id order. Items that are not stock products are simply absent. */
  lockItems(ids: string[]): Promise<LockedItem[]>;
  saleByKey(key: string): Promise<ExistingSale | null>;
  insertSale(s: { soldAt: Date; branch: string; method: string | null; buyerRef: string | null; remark: string | null; sellerRefs: string[]; actor: string | null; idempotencyKey: string }): Promise<string>;
  /** The SALE movement AND the new balance, together. Returns the movement id. */
  addSaleMovement(m: { itemId: string; saleId: string; qty: number; remainingAfter: number; valueMinor: number; idempotencyKey: string; actor: string | null; /** 🔻 TASK-911: the sale's business day (Bangkok) */ occurredOn?: string }): Promise<string>;
  insertSaleLine(l: { saleId: string; itemId: string; qty: number; unitPriceMinor: number; discountMinor: number; commissionMinor: number; movementId: string }): Promise<string>;
  /** 🔻 TASK-909 (row 21): the line's revenue (`postSaleLineRevenue`, in THIS transaction). A throw rolls the whole sale back. */
  postLineRevenue(r: { saleLineId: string; soldOn: string; branch: "BRAVO" | "OTHER"; method: "TRANSFER" | "CASH" | "CARD"; categoryId: string; productName: string; amountMinor: number; actor: string | null }): Promise<{ written: boolean }>;
}
export interface StockOutStore { transaction<T>(fn: (tx: StockOutTx) => Promise<T>): Promise<T> }

export const lineNetMinor = (l: CartLine): number => l.qty * l.unitPriceSatang - (l.discountSatang ?? 0);

export const dbStockOutStore: StockOutStore = {
  transaction: (fn) =>
    db.transaction(async (tx: any) =>
      fn({
        lockItems: async (ids) => {
          const rows = (await tx.select().from(boItem).where(and(eq(boItem.externalSource, STOCK_SOURCE), inArray(boItem.id, ids))).orderBy(asc(boItem.id)).for("update")) as Array<typeof boItem.$inferSelect>;
          return rows.map((i) => ({ id: i.id, model: i.externalRef ?? "", name: i.name, qty: i.remainingQty, active: i.active, revenueCategoryId: i.revenueCategoryId ?? null }));
        },
        saleByKey: async (key) => {
          const [s] = await tx.select().from(boSale).where(eq(boSale.idempotencyKey, key)).limit(1);
          if (!s) return null;
          const lines = await tx.select({ id: boSaleLine.id }).from(boSaleLine).where(eq(boSaleLine.saleId, s.id));
          return { id: s.id as string, soldAt: (s.soldAt as Date).toISOString(), lines: lines.length };
        },
        insertSale: async (s) => {
          const [row] = await tx.insert(boSale).values({ ...s }).returning({ id: boSale.id });
          return row.id as string;
        },
        addSaleMovement: async (m) => {
          await tx.update(boItem).set({ remainingQty: m.remainingAfter }).where(eq(boItem.id, m.itemId));
          const [mv] = await tx
            .insert(boMovement)
            .values({ itemId: m.itemId, qty: m.qty, remainingAfter: m.remainingAfter, valueMinor: m.valueMinor, reason: "Stock OUT sale", refType: "SALE", refId: m.saleId, idempotencyKey: m.idempotencyKey, actor: m.actor, occurredOn: m.occurredOn ?? null })
            .returning({ id: boMovement.id });
          return mv.id as string;
        },
        insertSaleLine: async (l) => {
          const [row] = await tx.insert(boSaleLine).values({ ...l }).returning({ id: boSaleLine.id });
          return row.id as string;
        },
        postLineRevenue: (r) => postSaleLineRevenue(tx, r), // 🔻 TASK-909: the sale's OWN tx — never `db`
      }),
    ),
};

export function createStockOutService(store: StockOutStore, now: () => Date = () => new Date()) {
  return {
    async sell(cart: Cart, actor: string | null): Promise<StockOutResult> {
      // the cart's own rules (a malformed cart is a 400 before anything is locked)
      const ids = cart.lines.map((l) => l.itemId);
      if (new Set(ids).size !== ids.length) throw badRequest("สินค้าซ้ำในตะกร้า — รวมเป็นบรรทัดเดียว", { field: "lines" });
      for (const l of cart.lines) {
        if (!Number.isInteger(l.qty) || l.qty <= 0) throw badRequest("qty ต้องเป็นจำนวนเต็มมากกว่า 0", { field: "qty", itemId: l.itemId });
        if ((l.discountSatang ?? 0) > l.qty * l.unitPriceSatang) throw badRequest("ส่วนลดเกินยอดของบรรทัด", { field: "discountSatang", itemId: l.itemId });
      }
      // 🔻 TASK-909 (row 21): the payment method is REQUIRED — the revenue line it posts has a NOT NULL method. Nothing is locked or written without it.
      if (!cart.method) throw new ApiException(400, "METHOD_REQUIRED", "ต้องระบุวิธีชำระเงิน (Transfer / Cash / Credit card)", { field: "method" });
      const method = cart.method; // narrowed by the check above
      const soldAt = cart.soldAt ? new Date(cart.soldAt) : now();
      if (Number.isNaN(soldAt.getTime())) throw badRequest("soldAt ไม่ถูกต้อง", { field: "soldAt" });
      if (soldAt.getTime() > now().getTime() + 24 * 3_600_000) throw badRequest("soldAt เป็นอนาคต", { field: "soldAt" });
      try {
        return await store.transaction(async (tx) => {
          const items = await tx.lockItems(ids); // locked FIRST: a second post of the same cart waits here and then sees the first
          const prior = await tx.saleByKey(cart.idempotencyKey);
          if (prior) return { saleId: prior.id, movementsWritten: prior.lines, soldAt: prior.soldAt, alreadyApplied: true as const };
          const byId = new Map(items.map((i) => [i.id, i]));
          // every line is checked BEFORE the first write: unknown / inactive / below zero refuse the whole sale
          const plan = cart.lines.map((l) => {
            const it = byId.get(l.itemId);
            if (!it) throw new ApiException(404, "UNKNOWN_ITEM", `ไม่พบสินค้า ${l.itemId} ในสต็อก`, { itemId: l.itemId });
            if (!it.active) throw new ApiException(409, "ITEM_INACTIVE", `«${it.model}» ถูกปิดใช้งาน`, { itemId: l.itemId, model: it.model });
            // 🔻 TASK-909 (row 21): a product with no revenue category cannot post its revenue ⇒ the WHOLE sale is refused, nothing written
            if (!it.revenueCategoryId) throw new ApiException(400, "NO_REVENUE_CATEGORY", `«${it.model}» ยังไม่ได้ตั้งหมวดรายได้ (revenue category)`, { itemId: l.itemId, model: it.model });
            const remainingAfter = refuseIfNegative(it.model, it.name, it.qty ?? 0, -l.qty);
            return { l, it, remainingAfter };
          });
          const saleId = await tx.insertSale({
            soldAt, branch: cart.branch ?? "BRAVO", method: cart.method ?? null, buyerRef: cart.buyerRef ?? null, remark: cart.remark ?? null,
            sellerRefs: cart.sellerRefs ?? [], actor, idempotencyKey: cart.idempotencyKey,
          });
          for (const { l, it, remainingAfter } of plan) {
            const movementId = await tx.addSaleMovement({ itemId: it.id, saleId, qty: -l.qty, remainingAfter, valueMinor: 0, idempotencyKey: `stock-out:${saleId}:${it.id}`, actor, occurredOn: bangkokDate(soldAt) }); // 🔻 TASK-911: the report shows the SALE's day, not the day it was keyed in
            const saleLineId = await tx.insertSaleLine({ saleId, itemId: it.id, qty: l.qty, unitPriceMinor: l.unitPriceSatang, discountMinor: l.discountSatang ?? 0, commissionMinor: l.commissionSatang ?? 0, movementId });
            // 🔻 TASK-909 (row 21): the line's revenue, in this same transaction — amount = the line NET (commission is pay, never revenue), category = the product's, method = the sale's
            await tx.postLineRevenue({ saleLineId, soldOn: bangkokDate(soldAt), branch: cart.branch ?? "BRAVO", method, categoryId: it.revenueCategoryId!, productName: it.name, amountMinor: lineNetMinor(l), actor });
          }
          return { saleId, movementsWritten: plan.length, soldAt: soldAt.toISOString() };
        });
      } catch (e) {
        if (e instanceof StockImportRefusal) {
          if (e.code === "NEGATIVE_BALANCE") throw new ApiException(409, "NEGATIVE_BALANCE", e.message, { model: e.model, name: e.item, resultingBalance: e.resultingBalance });
          throw new ApiException(409, e.code, e.message);
        }
        // two posts of one key racing past the check: the unique index decides, and the loser answers with the winner's result
        if (pgErrorCode(e) === "23505") {
          const again = await store.transaction(async (tx) => tx.saleByKey(cart.idempotencyKey));
          if (again) return { saleId: again.id, movementsWritten: again.lines, soldAt: again.soldAt, alreadyApplied: true };
        }
        throw e;
      }
    },
  };
}

export const stockOutService = createStockOutService(dbStockOutStore);
