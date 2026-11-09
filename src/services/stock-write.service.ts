// TASK-911 (REQ-120 R3.1 / R3.2) - the Stock WRITES that are not the import or the sale: create / edit a product by hand, and receive stock (Stock IN).
//
// It REUSES 904's store (`dbStockStore` / `StockTx`: createProduct, updateProduct, addMovement and the category-tag + commission_group semantics); nothing is copied.
//   * create: a `bo.item` (`external_source = stock`, `external_ref = code`, case-insensitive unique), `commission_group` = the group NAME only (the rate is a later layer),
//     the category through the «Category» tag, and ONE opening movement (value 0, `ref_type = STOCK_OPENING`, an ADJUSTMENT in the report) when `openingQuantity` > 0;
//   * edit: a FIELD edit only - it writes NO movement and never touches the balance (a balance moves by import / stock-out / stock-in);
//   * stock in: one STOCK_IN movement per line (+qty, `remaining_qty` raised in the same transaction), NO cost or price (R3.2), idempotent on the key (a re-POST writes nothing and
//     answers `alreadyApplied`), `occurred_on` = `receivedOn`. Products are locked FOR UPDATE first, so two posts of one key run one at a time and the second sees the first.
import { ApiException, badRequest, pgErrorCode } from "../lib/http";
import { bangkokDate } from "../lib/stock-read";
import { dbStockStore, type StockStore } from "./stock-import.service";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (s: string): boolean => DAY.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export interface ProductInput { code: string; name: string; category: string | null; priceSatang: number; commissionGroup: string | null; active: boolean; openingQuantity: number; /** 🔻 TASK-911 (row 21): REQUIRED - a product with none cannot be sold (NO_REVENUE_CATEGORY) */ revenueCategoryId: string }
export interface ProductEdit { name?: string; priceSatang?: number; category?: string | null; commissionGroup?: string | null; active?: boolean; /** can change, can never be cleared */ revenueCategoryId?: string }
export interface ProductDTO { id: string; code: string; name: string; category: string | null; priceSatang: number | null; quantity: number | null; commissionGroup: { name: string; amountSatang: number | null } | null; active: boolean; revenueCategoryId: string | null }
export interface StockInInput { idempotencyKey: string; receivedOn: string; lines: { itemId: string; qty: number }[] }
export interface StockInResult { receiptId: string; movementsWritten: number; receivedOn: string; alreadyApplied?: true }

const dto = (p: { id: string; model: string; name: string; priceMinor: number | null; qty: number | null; category: string | null; commissionGroup: string | null; active: boolean; revenueCategoryId?: string | null }): ProductDTO => ({
  id: p.id, code: p.model, name: p.name, category: p.category, priceSatang: p.priceMinor, quantity: p.qty,
  commissionGroup: p.commissionGroup ? { name: p.commissionGroup, amountSatang: null } : null, active: p.active, revenueCategoryId: p.revenueCategoryId ?? null,
});

/** The picker's set (GET /stock/revenue-categories): ACTIVE categories of type SALES / FNB / RENT / OTHER. Reuses 904's `tx.revenueCategories()`. */
const PICKER_TYPES = new Set(["SALES", "FNB", "RENT", "OTHER"]);
const categoryOk = async (tx: { revenueCategories?(): Promise<{ id: string; type: string }[]> }, id: string): Promise<boolean> => {
  if (!tx.revenueCategories) throw new Error("StockTx.revenueCategories is required by the product form");
  return (await tx.revenueCategories()).some((c) => c.id === id && PICKER_TYPES.has(c.type));
};
const text = (v: string | null | undefined, max: number, field: string): string | null => {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (t.length > max) throw badRequest(`${field} ยาวเกิน ${max} ตัวอักษร`, { field });
  return t === "" ? null : t;
};

export function createStockWriteService(store: StockStore = dbStockStore, now: () => Date = () => new Date()) {
  const need = <T,>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`StockTx.${what} is required by the stock-writes`);
    return v;
  };
  return {
    /** Create a product. 409 `DUPLICATE_CODE` (the code, case-insensitive) names the code; nothing is written then. */
    async createProduct(input: ProductInput, actor: string | null): Promise<ProductDTO> {
      const code = (input.code ?? "").trim();
      const name = (input.name ?? "").trim();
      if (!code || code.length > 64) throw badRequest("code ต้องไม่ว่างและไม่เกิน 64 ตัวอักษร", { field: "code" });
      if (!name || name.length > 200) throw badRequest("name ต้องไม่ว่างและไม่เกิน 200 ตัวอักษร", { field: "name" });
      if (!Number.isSafeInteger(input.priceSatang) || input.priceSatang < 0) throw badRequest("priceSatang ต้องเป็นจำนวนเต็มสตางค์ ≥ 0", { field: "priceSatang" });
      if (!Number.isSafeInteger(input.openingQuantity) || input.openingQuantity < 0) throw badRequest("openingQuantity ต้องเป็นจำนวนเต็ม ≥ 0", { field: "openingQuantity" });
      const category = text(input.category, 100, "category");
      const commissionGroup = text(input.commissionGroup, 100, "commissionGroup");
      if (typeof input.revenueCategoryId !== "string" || !input.revenueCategoryId) throw badRequest("ต้องเลือก revenueCategoryId (สินค้าที่ไม่มีหมวดรายได้ขายไม่ได้)", { field: "revenueCategoryId" });
      const today = bangkokDate(now());
      try {
        return await store.transaction(async (tx) => {
          const all = await tx.products(); // locked: two creates of one code cannot both pass the check
          if (!(await categoryOk(tx, input.revenueCategoryId))) throw new ApiException(400, "UNKNOWN_REVENUE_CATEGORY", "ไม่พบหมวดรายได้นี้ (หรือถูกปิดใช้งาน)", { field: "revenueCategoryId" });
          if (all.some((p) => p.model.toLowerCase() === code.toLowerCase())) throw new ApiException(409, "DUPLICATE_CODE", `รหัส «${code}» มีอยู่แล้ว`, { code });
          const id = await tx.createProduct({ model: code, name, priceMinor: input.priceSatang, commissionGroup, note: null, category, active: input.active, revenueCategoryId: input.revenueCategoryId });
          if (input.openingQuantity > 0) {
            await tx.addMovement(id, { qty: input.openingQuantity, remainingAfter: input.openingQuantity, reason: "Opening balance", idempotencyKey: `stock-product:${id}:opening`, batch: id, refType: "STOCK_OPENING", occurredOn: today, actor });
          }
          return dto({ id, model: code, name, priceMinor: input.priceSatang, qty: input.openingQuantity, category, commissionGroup, active: input.active, revenueCategoryId: input.revenueCategoryId });
        });
      } catch (e) {
        if (pgErrorCode(e) === "23505") throw new ApiException(409, "DUPLICATE_CODE", `รหัส «${code}» มีอยู่แล้ว`, { code }); // the unique index beat the check
        throw e;
      }
    },

    /** Edit fields only. No movement, never a balance change. 404 for an unknown / non-stock id. */
    async editProduct(id: string, edit: ProductEdit): Promise<ProductDTO> {
      if (edit.name !== undefined && (!edit.name.trim() || edit.name.trim().length > 200)) throw badRequest("name ต้องไม่ว่างและไม่เกิน 200 ตัวอักษร", { field: "name" });
      if (edit.priceSatang !== undefined && (!Number.isSafeInteger(edit.priceSatang) || edit.priceSatang < 0)) throw badRequest("priceSatang ต้องเป็นจำนวนเต็มสตางค์ ≥ 0", { field: "priceSatang" });
      const fields: { name?: string; priceMinor?: number; category?: string | null; commissionGroup?: string | null; active?: boolean; revenueCategoryId?: string } = {};
      if (edit.name !== undefined) fields.name = edit.name.trim();
      if (edit.priceSatang !== undefined) fields.priceMinor = edit.priceSatang;
      if (edit.category !== undefined) fields.category = text(edit.category, 100, "category");
      if (edit.commissionGroup !== undefined) fields.commissionGroup = text(edit.commissionGroup, 100, "commissionGroup");
      if (edit.active !== undefined) fields.active = edit.active;
      if (edit.revenueCategoryId !== undefined) fields.revenueCategoryId = edit.revenueCategoryId;
      if (!Object.keys(fields).length) throw badRequest("ไม่มีฟิลด์ให้แก้ไข");
      return store.transaction(async (tx) => {
        const cur = (await tx.products()).find((p) => p.id === id);
        if (!cur) throw new ApiException(404, "UNKNOWN_ITEM", "ไม่พบสินค้านี้ในสต็อก", { itemId: id });
        if (fields.revenueCategoryId !== undefined && !(await categoryOk(tx, fields.revenueCategoryId))) throw new ApiException(400, "UNKNOWN_REVENUE_CATEGORY", "ไม่พบหมวดรายได้นี้ (หรือถูกปิดใช้งาน)", { field: "revenueCategoryId" });
        await tx.updateProduct(id, fields);
        return dto({
          ...cur,
          name: fields.name ?? cur.name,
          priceMinor: fields.priceMinor ?? cur.priceMinor,
          category: fields.category !== undefined ? fields.category : cur.category,
          commissionGroup: fields.commissionGroup !== undefined ? fields.commissionGroup : cur.commissionGroup,
          active: fields.active ?? cur.active,
          revenueCategoryId: fields.revenueCategoryId ?? (cur as { revenueCategoryId?: string | null }).revenueCategoryId ?? null,
        });
      });
    },

    /** Receive stock. One STOCK_IN movement per line; idempotent on `idempotencyKey` (a re-POST = `alreadyApplied`, nothing added). */
    async stockIn(input: StockInInput, actor: string | null): Promise<StockInResult> {
      if (!realDay(input.receivedOn)) throw badRequest("receivedOn ต้องเป็นวันที่ YYYY-MM-DD ที่มีจริง", { field: "receivedOn" });
      if (input.receivedOn > bangkokDate(now())) throw badRequest("receivedOn เป็นอนาคต", { field: "receivedOn" });
      const ids = input.lines.map((l) => l.itemId);
      if (!input.lines.length) throw badRequest("ต้องมีอย่างน้อย 1 บรรทัด", { field: "lines" });
      if (new Set(ids).size !== ids.length) throw badRequest("สินค้าซ้ำ — รวมเป็นบรรทัดเดียว", { field: "lines" });
      for (const l of input.lines) if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw badRequest("qty ต้องเป็นจำนวนเต็มมากกว่า 0", { field: "qty", itemId: l.itemId });
      const receiptId = input.idempotencyKey;
      const prefix = `stock-in:${input.idempotencyKey}:`;
      const run = () =>
        store.transaction(async (tx) => {
          const all = await tx.products(); // locked FOR UPDATE: a second post of the same key waits here and then sees the first
          const prior = await need(tx.countKey, "countKey").call(tx, prefix);
          if (prior > 0) return { receiptId, movementsWritten: prior, receivedOn: input.receivedOn, alreadyApplied: true as const };
          const byId = new Map(all.map((p) => [p.id, p]));
          const plan = input.lines.map((l) => {
            const it = byId.get(l.itemId);
            if (!it) throw new ApiException(404, "UNKNOWN_ITEM", `ไม่พบสินค้า ${l.itemId} ในสต็อก`, { itemId: l.itemId });
            if (!it.active) throw new ApiException(409, "ITEM_INACTIVE", `«${it.model}» ถูกปิดใช้งาน`, { itemId: l.itemId, model: it.model });
            return { l, it, after: (it.qty ?? 0) + l.qty };
          });
          for (const { l, it, after } of plan) {
            await tx.addMovement(it.id, { qty: l.qty, remainingAfter: after, reason: "Stock IN", idempotencyKey: `${prefix}${it.id}`, batch: receiptId, refType: "STOCK_IN", occurredOn: input.receivedOn, actor });
          }
          return { receiptId, movementsWritten: plan.length, receivedOn: input.receivedOn };
        });
      try {
        return await run();
      } catch (e) {
        // two posts of one key racing past the check: the unique index decides, and the loser answers as already applied
        if (pgErrorCode(e) === "23505") return run();
        throw e;
      }
    },
  };
}

export const stockWriteService = createStockWriteService();
