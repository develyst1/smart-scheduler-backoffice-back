// TASK-904 — the Stock git-style import: preview (read the sheet, compute the diff, WRITE NOTHING) and apply (the confirmed diff → movements +
// field edits + new products, ONE transaction, idempotent on the batch). The rules live in `lib/stock-import.ts`; this file is the IO.
//
//   • products are `bo.item` rows with `external_source = 'stock'`, keyed by `external_ref` (= Model code); new ones are `direction = INCOME`, `ceiling_qty NULL`;
//   • the on-hand balance is `bo.item.remaining_qty`, moved in the SAME transaction as its `bo.movement` (signed qty, `value_minor = 0`: a stock count is not a sale,
//     so it must never reach the P&L); the opening balance of a new product is ONE movement (the card starts from a movement);
//   • a movement's `idempotency_key` = `stock-import:<batch>:<model>` and the batch is a hash of the confirmed diff, so a re-apply writes nothing;
//   • nothing is ever deleted: a `removed` entry is shown and skipped.
import ExcelJS from "exceljs";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../db";
import { boItem, boItemTag, boMovement, boTagGroup, boTagValue } from "../db/schema";
import { boRevenueCategory } from "../db/schema-revenue"; // 🔻 TASK-909
import { ApiException, badRequest, conflict } from "../lib/http";
import { bangkokDate } from "../lib/stock-read";
import {
  CATEGORY_GROUP, DEFAULT_REVENUE_CATEGORY, STOCK_SOURCE, StockImportRefusal, batchOf, computeDiff, matchRevenueCategory, parseStockSheet, planApply,
  previewRows, type Diff, type DiffEntry, type DiffFlag, type FieldChange, type PreviewRow, type RevenueCat, type StockProduct,
} from "../lib/stock-import";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// ───────────────────────────── reading the file ─────────────────────────────

export const cellValue = (v: ExcelJS.CellValue): unknown => { // 🔻 TASK-915: exported - the Demo seed reads the same workbook cells (rich text, formulas, hyperlinks)
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return cellValue(o.result as ExcelJS.CellValue); // a formula: its value
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text: string }>).map((t) => t.text).join("");
    if (typeof o.text === "string") return o.text; // a hyperlink
    if ("error" in o) return "";
    return "";
  }
  return v;
};

/** The upload → the grid. A file that is not a readable .xlsx is a 400, never a crash. */
export async function readStockGrid(bytes: Uint8Array): Promise<unknown[][]> {
  if (bytes.byteLength === 0) throw badRequest("ไฟล์ว่าง");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw badRequest("ไฟล์ใหญ่เกิน 5 MB");
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw badRequest("ไฟล์ต้องเป็น .xlsx");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw badRequest("อ่านไฟล์ .xlsx ไม่ได้");
  }
  const ws = wb.worksheets.find((s) => /balance/i.test(s.name)) ?? wb.worksheets[0]; // «Balance Stock», never «Demo»
  if (!ws) throw badRequest("ไฟล์ไม่มี sheet");
  const grid: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const cells: unknown[] = [];
    for (let c = 1; c <= Math.min(ws.columnCount, 60); c++) cells.push(cellValue(row.getCell(c).value));
    grid[n - 1] = cells;
  });
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  return grid;
}

// ───────────────────────────── the store ─────────────────────────────

export interface NewProduct { model: string; name: string; priceMinor: number | null; commissionGroup: string | null; note: string | null; category: string | null; /** 🔻 TASK-911: default true */ active?: boolean; /** 🔻 TASK-909: the revenue category a sale posts into */ revenueCategoryId?: string | null }
export interface ProductPatch { name?: string; priceMinor?: number; commissionGroup?: string | null; note?: string | null; category?: string | null; /** 🔻 TASK-911 */ active?: boolean; /** 🔻 TASK-909 */ revenueCategoryId?: string | null }

export interface StockTx {
  /** Every stock product, locked for the rest of the transaction. */
  products(): Promise<StockProduct[]>;
  batchApplied(batch: string): Promise<boolean>;
  createProduct(p: NewProduct): Promise<string>;
  updateProduct(id: string, patch: ProductPatch): Promise<void>;
  /** The movement AND the new balance, together. */
  addMovement(id: string, m: { qty: number; remainingAfter: number; reason: string; idempotencyKey: string; batch: string; /** 🔻 TASK-911: default STOCK_IMPORT */ refType?: string; /** 🔻 TASK-911: the business day (Bangkok); default = today */ occurredOn?: string; actor?: string | null }): Promise<void>;
  /** 🔻 TASK-911 (the stock-writes): how many movements already carry an idempotency key that starts with `prefix` (0 = none). Optional so the import's own fakes need no change. */
  countKey?(prefix: string): Promise<number>;
  /** 🔻 TASK-909 (row 21): the active revenue categories, and the default SALES / «Product sales» (found, or created). Optional: a store without them maps nothing. */
  revenueCategories?(): Promise<RevenueCat[]>;
  ensureDefaultRevenueCategory?(): Promise<string>;
}
export interface StockStore {
  products(): Promise<StockProduct[]>;
  /** 🔻 TASK-909: read-only, for the preview's flags. Optional (see StockTx). */
  revenueCategories?(): Promise<RevenueCat[]>;
  transaction<T>(fn: (tx: StockTx) => Promise<T>): Promise<T>;
}

export async function readProducts(exec: any, lock: boolean): Promise<StockProduct[]> {
  const q = exec.select().from(boItem).where(eq(boItem.externalSource, STOCK_SOURCE));
  const items = (lock ? await q.for("update") : await q) as Array<typeof boItem.$inferSelect>;
  if (!items.length) return [];
  const cats = (await exec
    .select({ itemId: boItemTag.itemId, label: boTagValue.label })
    .from(boItemTag)
    .innerJoin(boTagGroup, eq(boTagGroup.id, boItemTag.tagGroupId))
    .innerJoin(boTagValue, eq(boTagValue.id, boItemTag.tagValueId))
    .where(and(eq(boTagGroup.name, CATEGORY_GROUP), inArray(boItemTag.itemId, items.map((i) => i.id))))) as Array<{ itemId: string; label: string }>;
  const catOf = new Map(cats.map((c) => [c.itemId, c.label]));
  return items.map((i) => ({
    id: i.id, model: i.externalRef ?? "", name: i.name, priceMinor: i.unitPriceMinor, qty: i.remainingQty,
    category: catOf.get(i.id) ?? null, commissionGroup: i.commissionGroup ?? null,
    note: typeof i.metadata?.note === "string" ? (i.metadata.note as string) : null, active: i.active,
    revenueCategoryId: i.revenueCategoryId ?? null,
  }));
}

/** 🔻 TASK-909: the active revenue categories (id, type, name). */
async function readRevenueCategories(exec: any): Promise<RevenueCat[]> {
  const rows = (await exec.select({ id: boRevenueCategory.id, type: boRevenueCategory.type, name: boRevenueCategory.name }).from(boRevenueCategory).where(eq(boRevenueCategory.active, true))) as RevenueCat[];
  return rows;
}
/** 🔻 TASK-909: SALES / «Product sales» — found (any case), or created once. The unique index (type, lower(name)) makes a racing create harmless. */
async function ensureDefaultRevenueCategory(tx: any): Promise<string> {
  const find = async () => {
    const [c] = await tx.select({ id: boRevenueCategory.id }).from(boRevenueCategory).where(and(eq(boRevenueCategory.type, DEFAULT_REVENUE_CATEGORY.type), sql`lower(${boRevenueCategory.name}) = lower(${DEFAULT_REVENUE_CATEGORY.name})`)).limit(1);
    return c?.id as string | undefined;
  };
  const have = await find();
  if (have) return have;
  const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${boRevenueCategory.sortOrder}), -1) + 1` }).from(boRevenueCategory).where(eq(boRevenueCategory.type, DEFAULT_REVENUE_CATEGORY.type));
  await tx.insert(boRevenueCategory).values({ type: DEFAULT_REVENUE_CATEGORY.type, name: DEFAULT_REVENUE_CATEGORY.name, sortOrder: Number(next) }).onConflictDoNothing();
  const made = await find();
  if (!made) throw new Error("the default revenue category is missing after its insert");
  return made;
}

async function setCategory(tx: any, itemId: string, label: string | null) {
  await tx.delete(boItemTag).where(and(eq(boItemTag.itemId, itemId), eq(boItemTag.tagGroupId, sql`(select id from bo.tag_group where name = ${CATEGORY_GROUP} limit 1)`)));
  if (!label) return;
  let [g] = await tx.select().from(boTagGroup).where(eq(boTagGroup.name, CATEGORY_GROUP)).limit(1);
  if (!g) [g] = await tx.insert(boTagGroup).values({ name: CATEGORY_GROUP }).returning();
  let [v] = await tx.select().from(boTagValue).where(and(eq(boTagValue.tagGroupId, g.id), sql`lower(${boTagValue.label}) = lower(${label})`)).limit(1);
  if (!v) [v] = await tx.insert(boTagValue).values({ tagGroupId: g.id, label }).returning();
  await tx.insert(boItemTag).values({ itemId, tagValueId: v.id, tagGroupId: g.id });
}

/** 🔻 TASK-911: the store over an executor (the global `db`, or a transaction a probe rolls back - a nested `transaction` is then a savepoint). */
export const makeDbStockStore = (exec: any = db): StockStore => ({
  products: () => readProducts(exec, false),
  revenueCategories: () => readRevenueCategories(exec),
  transaction: (fn) =>
    exec.transaction(async (tx: any) =>
      fn({
        products: () => readProducts(tx, true),
        revenueCategories: () => readRevenueCategories(tx),
        ensureDefaultRevenueCategory: () => ensureDefaultRevenueCategory(tx),
        batchApplied: async (batch) => {
          const r = await tx.select({ id: boMovement.id }).from(boMovement).where(like(boMovement.idempotencyKey, `stock-import:${batch}:%`)).limit(1);
          return r.length > 0;
        },
        createProduct: async (p) => {
          const [row] = await tx
            .insert(boItem)
            .values({
              name: p.name, unit: "each", direction: "INCOME", cadence: "VARIABLE", unitPriceMinor: p.priceMinor ?? 0, ceilingQty: null, remainingQty: 0,
              externalSource: STOCK_SOURCE, externalRef: p.model, commissionGroup: p.commissionGroup, metadata: p.note ? { note: p.note } : null, active: p.active ?? true, revenueCategoryId: p.revenueCategoryId ?? null,
            })
            .returning({ id: boItem.id });
          if (p.category) await setCategory(tx, row.id, p.category);
          return row.id as string;
        },
        updateProduct: async (id, patch) => {
          const set: Partial<typeof boItem.$inferInsert> = {};
          if (patch.name !== undefined) set.name = patch.name;
          if (patch.priceMinor !== undefined) set.unitPriceMinor = patch.priceMinor;
          if (patch.commissionGroup !== undefined) set.commissionGroup = patch.commissionGroup;
          if (patch.active !== undefined) set.active = patch.active; // 🔻 TASK-911
          if (patch.revenueCategoryId !== undefined) set.revenueCategoryId = patch.revenueCategoryId; // 🔻 TASK-909
          if (patch.note !== undefined) {
            const [cur] = await tx.select({ metadata: boItem.metadata }).from(boItem).where(eq(boItem.id, id));
            const md = { ...(cur?.metadata ?? {}) } as Record<string, unknown>;
            if (patch.note) md.note = patch.note; else delete md.note;
            set.metadata = md;
          }
          if (Object.keys(set).length) await tx.update(boItem).set(set).where(eq(boItem.id, id));
          if (patch.category !== undefined) await setCategory(tx, id, patch.category);
        },
        addMovement: async (id, m) => {
          await tx.update(boItem).set({ remainingQty: m.remainingAfter }).where(eq(boItem.id, id));
          await tx.insert(boMovement).values({
            itemId: id, qty: m.qty, remainingAfter: m.remainingAfter, valueMinor: 0, reason: m.reason,
            refType: "STOCK_IMPORT", refId: m.batch, idempotencyKey: m.idempotencyKey, actor: m.actor ?? null, ...(m.refType ? { refType: m.refType } : {}), // 🔻 TASK-911: the stock-writes name their own ref type
            occurredOn: m.occurredOn ?? bangkokDate(new Date()), // 🔻 TASK-911: explicit business day (an import = the day it is applied)
          });
        },
        countKey: async (prefix) => {
          const r = await tx.select({ id: boMovement.id }).from(boMovement).where(like(boMovement.idempotencyKey, `${prefix.replace(/[\%_]/g, (c: string) => `\${c}`)}%`));
          return r.length;
        },
      }),
    ),
});
export const dbStockStore: StockStore = makeDbStockStore();

// ───────────────────────────── the service ─────────────────────────────

const patchOf = (fields: FieldChange[]): ProductPatch => {
  const p: ProductPatch = {};
  for (const f of fields) {
    if (f.field === "name") p.name = String(f.after);
    else if (f.field === "priceMinor") p.priceMinor = Number(f.after);
    else if (f.field === "category") p.category = f.after === null ? null : String(f.after);
    else if (f.field === "commissionGroup") p.commissionGroup = f.after === null ? null : String(f.after);
    else if (f.field === "note") p.note = f.after === null ? null : String(f.after);
  }
  return p;
};

export interface ApplyResult { batchId: string; movementsWritten: number; itemsAdded: number; fieldEdits: number; removedLeft: number; alreadyApplied?: true }
export interface PreviewResult { batchId: string; rows: PreviewRow[]; notImported: string[]; flags: DiffFlag[]; unchanged: number }

/**
 * The staged previews. A preview is STAGED server-side under its batch id (the diff is never sent back by the client, so it cannot be tampered with between
 * preview and apply); apply reads it from here. In process memory, 30 minutes, at most 20 batches — a restart or an expiry means «preview again» (404
 * BATCH_NOT_FOUND), except that a batch already applied is recognised from its movements and answers `alreadyApplied`.
 */
export function createStaging(now: () => number = Date.now, ttlMs = 30 * 60_000, cap = 20) {
  const m = new Map<string, { entries: DiffEntry[]; at: number }>();
  const sweep = () => { const t = now(); for (const [k, v] of m) if (t - v.at > ttlMs) m.delete(k); };
  return {
    put(batch: string, entries: DiffEntry[]) {
      sweep();
      m.delete(batch);
      m.set(batch, { entries, at: now() });
      while (m.size > cap) m.delete(m.keys().next().value as string); // the oldest goes
    },
    get(batch: string): DiffEntry[] | null { sweep(); return m.get(batch)?.entries ?? null; },
    size: () => m.size,
  };
}
export type Staging = ReturnType<typeof createStaging>;

export function createStockImportService(store: StockStore, staging: Staging = createStaging()) {
  const stage = async (grid: unknown[][]): Promise<PreviewResult> => {
    const sheet = parseStockSheet(grid);
    if (sheet.errors.length) throw badRequest(`ไฟล์มี ${sheet.errors.length} จุดที่ไม่ถูกต้อง`, { errors: sheet.errors.slice(0, 100), total: sheet.errors.length });
    const current = await store.products();
    const d: Diff = computeDiff(sheet, current);
    staging.put(d.batch, d.entries);
    // 🔻 TASK-909 (row 21): every product that will be WRITTEN without a category the sheet can place falls into SALES / «Product sales» — said, row by row, so nothing is silent
    const flags: DiffFlag[] = [...d.flags];
    const cats = store.revenueCategories ? await store.revenueCategories() : null;
    if (cats) {
      const touched = new Set(d.entries.filter((e) => e.kind !== "removed").map((e) => e.model.toLowerCase()));
      const have = new Map(current.map((p) => [p.model.toLowerCase(), p]));
      for (const r of sheet.rows) {
        const k = r.model.toLowerCase();
        const p = have.get(k);
        if (!touched.has(k) || (p && p.revenueCategoryId)) continue; // not written, or it already has one
        if (!matchRevenueCategory(r.category ?? p?.category ?? null, cats))
          flags.push({ model: r.model, row: r.row, message: `No revenue category matches «${r.category ?? p?.category ?? "(no Type)"}» — will use ${DEFAULT_REVENUE_CATEGORY.type} / ${DEFAULT_REVENUE_CATEGORY.name}` });
      }
    }
    return { batchId: d.batch, rows: previewRows(d.entries), notImported: d.notImported, flags, unchanged: d.unchanged };
  };
  return {
    /** Read the sheet, compute the diff and STAGE it under its batch id. Writes NOTHING to the database. A bad cell / header is a 400 listing every problem. */
    async preview(bytes: Uint8Array): Promise<PreviewResult> {
      return stage(await readStockGrid(bytes));
    },
    /** The same from an already-parsed grid (tests; no file format). */
    previewGrid: stage,
    /** The staged entries of a batch (tests). */
    staged: (batch: string) => staging.get(batch),
    /**
     * Write the CONFIRMED diff. One transaction, products locked: the plan is re-checked against the balances NOW (a stale preview ⇒ 409 STALE; a balance
     * that would go negative ⇒ 409 NEGATIVE_BALANCE naming the item) and then everything is written, or nothing. A batch already applied writes nothing.
     */
    async apply(batchId: string): Promise<ApplyResult> {
      const staged = staging.get(batchId);
      const entries: DiffEntry[] = staged ?? [];
      try {
        return await store.transaction(async (tx) => {
          const current = await tx.products();
          // the batch is asked FIRST: after a successful apply the balances have moved, so the same staged diff would otherwise read as STALE instead of «already applied»
          const batch = staged ? batchOf(entries) : batchId;
          if (await tx.batchApplied(batch)) return { batchId: batch, alreadyApplied: true as const, movementsWritten: 0, itemsAdded: 0, fieldEdits: 0, removedLeft: entries.filter((e) => e.kind === "removed").length };
          if (!staged) throw new ApiException(404, "BATCH_NOT_FOUND", "ไม่พบ batch นี้หรือหมดอายุแล้ว (เก็บไว้ 30 นาที) — ให้ preview ใหม่");
          const { movements } = planApply(entries, current);
          const byModel = new Map(current.map((p) => [p.model.toLowerCase(), p]));
          const keyOf = new Map(movements.map((m) => [m.model.toLowerCase(), m]));
          const cats = tx.revenueCategories && tx.ensureDefaultRevenueCategory ? await tx.revenueCategories() : null; // 🔻 TASK-909
          const revenueCategoryFor = async (label: string | null) => (cats ? (matchRevenueCategory(label, cats)?.id ?? (await tx.ensureDefaultRevenueCategory!())) : undefined);
          let created = 0, adjusted = 0, edited = 0, wrote = 0;
          for (const e of entries) {
            if (e.kind === "removed") continue; // shown, never deleted
            const mv = keyOf.get(e.model.toLowerCase());
            if (e.kind === "new") {
              const f = patchOf(e.fields);
              const id = await tx.createProduct({ model: e.model, name: f.name ?? e.name, priceMinor: f.priceMinor ?? null, commissionGroup: f.commissionGroup ?? null, note: f.note ?? null, category: f.category ?? null, revenueCategoryId: await revenueCategoryFor(f.category ?? null) });
              created++;
              if (mv) { await tx.addMovement(id, { qty: mv.qty, remainingAfter: mv.qty, reason: mv.reason, idempotencyKey: mv.idempotencyKey, batch }); wrote++; }
              continue;
            }
            const p = byModel.get(e.model.toLowerCase())!;
            const patch = patchOf(e.fields);
            if (cats && !p.revenueCategoryId) patch.revenueCategoryId = await revenueCategoryFor(patch.category ?? p.category); // 🔻 TASK-909: an existing product with no revenue category gets one the day it is touched
            if (e.fields.length || patch.revenueCategoryId) { await tx.updateProduct(p.id, patch); if (e.fields.length) edited++; }
            if (mv) { await tx.addMovement(p.id, { qty: mv.qty, remainingAfter: (p.qty ?? 0) + mv.qty, reason: mv.reason, idempotencyKey: mv.idempotencyKey, batch }); adjusted++; wrote++; }
          }
          return { batchId: batch, movementsWritten: wrote, itemsAdded: created, fieldEdits: edited, removedLeft: entries.filter((e) => e.kind === "removed").length };
        });
      } catch (e) {
        if (e instanceof StockImportRefusal) {
          if (e.code === "BAD_DIFF") throw badRequest(e.message, { model: e.model });
          if (e.code === "NEGATIVE_BALANCE") throw new ApiException(409, "NEGATIVE_BALANCE", e.message, { model: e.model, name: e.item, resultingBalance: e.resultingBalance });
          throw conflict(e.code, e.message);
        }
        if (e instanceof ApiException) throw e;
        throw e;
      }
    },
  };
}

export const stockImportService = createStockImportService(dbStockStore);
