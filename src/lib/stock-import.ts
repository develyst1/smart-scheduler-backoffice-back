// TASK-904 (REQ-120 R3.4 + the owner's git-style rule) — the Stock import, PURE: parse a sheet (array of rows), compute the DIFF against the
// stock products now, and name the batch. No database, no file format here — `stock-import.service.ts` reads the .xlsx and writes the rows.
//
//   • matched by MODEL CODE (= `bo.item.external_ref`, source `STOCK_SOURCE`);
//   • four kinds — `new` · `qty_change` · `field_change` · `removed` — and a row that did not change is not listed (only counted);
//   • a price / name / category / commission / note change is a FIELD edit, never a movement; a balance change is a MOVEMENT;
//   • a removed row (in the shop, not in the sheet) is SHOWN, never deleted;
//   • money is integer satang — the sheet's baht are parsed from the digits, never through a float multiply;
//   • the sheet's «Other» balance is future branches (Khwan QR3) — reported as «not imported», never written.
import { createHash } from "node:crypto";

export const STOCK_SOURCE = "stock";
export const CATEGORY_GROUP = "Category";
export const MAX_SHEET_ROWS = 5000;

export type DiffKind = "new" | "qty_change" | "field_change" | "removed";
export type FieldName = "name" | "priceMinor" | "category" | "commissionGroup" | "note";

export interface SheetRow {
  row: number; // 1-based sheet row, for error messages
  model: string;
  name: string;
  category: string | null | undefined; // undefined = column absent / blank ⇒ leave as is
  priceMinor: number | null | undefined;
  commissionGroup: string | null | undefined;
  note: string | null | undefined;
  qty: number | null; // the Bravo balance; null = blank ⇒ leave as is
  other: string | null; // the «Other» cell as written when it is NOT zero/blank — future branches are not imported, so it is FLAGGED (never silently dropped)
}

export interface SheetError { row: number; column: string; message: string }
export interface ParsedSheet { rows: SheetRow[]; notImported: string[]; errors: SheetError[] }

/** What the shop holds now for one stock product (the service reads it). */
export interface StockProduct {
  id: string;
  model: string;
  name: string;
  priceMinor: number;
  qty: number | null; // bo.item.remaining_qty
  category: string | null;
  commissionGroup: string | null;
  note: string | null;
  active: boolean;
  /** 🔻 TASK-909 companion — the revenue category a sale of this product posts into (null = none yet). Optional so older fixtures need no change. */
  revenueCategoryId?: string | null;
}

export interface FieldChange { field: FieldName; before: string | number | null; after: string | number | null }
export interface DiffEntry {
  model: string;
  kind: DiffKind;
  itemId: string | null; // null for `new`
  name: string;
  before: { qty: number | null } | null;
  after: { qty: number | null } | null;
  delta: number; // signed qty change; 0 for a field-only change; 0 for `removed`
  fields: FieldChange[]; // every field that changes (for `new`: every field the sheet sets)
}
export interface DiffFlag { model: string; row: number; message: string }
export interface Diff { entries: DiffEntry[]; unchanged: number; notImported: string[]; flags: DiffFlag[]; batch: string }

// ───────────────────────────── the sheet ─────────────────────────────

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const text = (v: unknown): string => String(v ?? "").trim();

type Col = "model" | "name" | "category" | "price" | "commission" | "note" | "bravo" | "picture" | "other";
const HEADER: Record<string, Col> = {
  "model code": "model", "model": "model", "code": "model",
  "name": "name", "product name": "name",
  "type": "category", "category": "category",
  "price": "price", "unit price": "price", "sale price": "price",
  "commission group": "commission", "commission": "commission",
  "remark": "note", "note": "note",
  "bravo": "bravo", "balance": "bravo", "quantity": "bravo", "qty": "bravo",
  "picture": "picture", "image": "picture",
  "other": "other",
};

/** Baht → satang from the DIGITS (no float multiply). «12», «12.5», «12.50», «1,200.00» ok; «12.505», «abc», negative ⇒ null. */
export function satangFromBaht(v: unknown): number | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : text(v).replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
}

/** A whole, non-negative balance. «3», 3, «3.0» ok; «-1», «1.5», «abc» ⇒ null; blank is the caller's. */
export function wholeQty(v: unknown): number | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : text(v);
  const m = /^(\d{1,9})(?:\.0+)?$/.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * `grid` = the sheet as rows of cells (index 0 = first sheet row). The header is found in the first 10 rows (the row holding «Model Code»);
 * the customer's file has a two-row header — «Balance» over «Bravo / Other» — so the row under it is read as the sub-header.
 * Every problem is collected, never thrown: a bad cell is a 400 the caller shows, not a crash.
 */
export function parseStockSheet(grid: unknown[][]): ParsedSheet {
  const errors: SheetError[] = [];
  const hIdx = grid.slice(0, 10).findIndex((r) => r.some((c) => norm(c) === "model code" || norm(c) === "model"));
  if (hIdx < 0) return { rows: [], notImported: [], errors: [{ row: 1, column: "header", message: "ไม่พบหัวคอลัมน์ «Model Code»" }] };
  const head = grid[hIdx];
  const sub = grid[hIdx + 1] ?? [];
  const subIsHeader = sub.some((c) => ["bravo", "other"].includes(norm(c)));
  const width = Math.max(head.length, sub.length);
  const cols = new Map<number, Col>();
  let otherCol = -1;
  const notImported: string[] = [];
  const seen = new Set<Col>();
  for (let i = 0; i < width; i++) {
    const top = norm(head[i]);
    const low = subIsHeader ? norm(sub[i]) : "";
    const label = low === "bravo" || low === "other" ? low : top; // the sub-header wins where there is one («Balance» ⇒ «Bravo»)
    if (!label) continue;
    const c = HEADER[label];
    if (!c) { notImported.push(text(head[i]) || text(sub[i])); continue; }
    if (c === "other") { notImported.push("Other (future branches)"); otherCol = i; continue; }
    if (c === "picture") { notImported.push("Picture"); continue; }
    if (seen.has(c)) { notImported.push(`${text(head[i]) || label} (duplicate column)`); continue; }
    seen.add(c);
    cols.set(i, c);
  }
  for (const need of ["model", "name"] as const)
    if (!seen.has(need)) errors.push({ row: hIdx + 1, column: need, message: `ไม่พบคอลัมน์ ${need === "model" ? "Model Code" : "Name"}` });
  if (errors.length) return { rows: [], notImported, errors };

  const rows: SheetRow[] = [];
  const codes = new Map<string, number>();
  const start = hIdx + (subIsHeader ? 2 : 1);
  let ignored = 0;
  if (grid.length - start > MAX_SHEET_ROWS) return { rows: [], notImported, errors: [{ row: start + 1, column: "sheet", message: `ไฟล์ใหญ่เกิน ${MAX_SHEET_ROWS} แถว` }] };
  for (let r = start; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const get = (c: Col): unknown => { for (const [i, k] of cols) if (k === c) return cells[i]; return undefined; };
    if ([...cols.keys()].every((i) => text(cells[i]) === "")) continue; // a blank line
    const rowNo = r + 1;
    const model = text(get("model"));
    const name = text(get("name"));
    // the customer's file ends with a list of the categories (rows with a Type and nothing else): not a product, not an error — counted and reported
    if (!model && !name && !["bravo", "price", "note", "commission"].some((c) => text(get(c as Col)) !== "")) { ignored++; continue; }
    if (!model) { errors.push({ row: rowNo, column: "Model Code", message: "Model Code ว่าง" }); continue; }
    if (model.length > 64) errors.push({ row: rowNo, column: "Model Code", message: "Model Code ยาวเกิน 64 ตัวอักษร" });
    if (!name) errors.push({ row: rowNo, column: "Name", message: "Name ว่าง" });
    if (name.length > 200) errors.push({ row: rowNo, column: "Name", message: "Name ยาวเกิน 200 ตัวอักษร" });
    const key = model.toLowerCase();
    if (codes.has(key)) errors.push({ row: rowNo, column: "Model Code", message: `Model Code «${model}» ซ้ำกับแถว ${codes.get(key)}` });
    else codes.set(key, rowNo);
    const opt = (c: Col): string | null | undefined => (seen.has(c) ? (text(get(c)) || null) : undefined);
    let priceMinor: number | null | undefined = undefined;
    if (seen.has("price")) {
      const raw = get("price");
      if (text(raw) === "") priceMinor = undefined;
      else { priceMinor = satangFromBaht(raw); if (priceMinor === null) { errors.push({ row: rowNo, column: "Price", message: `ราคา «${text(raw)}» ไม่ถูกต้อง` }); priceMinor = undefined; } }
    }
    let qty: number | null = null;
    if (seen.has("bravo") && text(get("bravo")) !== "") {
      qty = wholeQty(get("bravo"));
      if (qty === null) errors.push({ row: rowNo, column: "Balance (Bravo)", message: `จำนวน «${text(get("bravo"))}» ต้องเป็นจำนวนเต็ม ≥ 0` });
    }
    const note = opt("note");
    const cg = opt("commission");
    if ((note ?? "").length > 500) errors.push({ row: rowNo, column: "Remark", message: "Remark ยาวเกิน 500 ตัวอักษร" });
    if ((cg ?? "").length > 100) errors.push({ row: rowNo, column: "Commission", message: "Commission ยาวเกิน 100 ตัวอักษร" });
    const cat = opt("category");
    if ((cat ?? "").length > 100) errors.push({ row: rowNo, column: "Type", message: "Type ยาวเกิน 100 ตัวอักษร" });
    const oRaw = otherCol >= 0 ? text(cells[otherCol]) : "";
    const other = oRaw !== "" && !(wholeQty(oRaw) === 0) ? oRaw : null; // blank or a zero is nothing; any other value (3, «abc», -2) is flagged
    rows.push({ row: rowNo, model, name, category: cat, priceMinor, commissionGroup: cg, note, qty, other });
  }
  if (ignored) notImported.push(`${ignored} row(s) with only a Type (no code, no name) — ignored`);
  return { rows, notImported: [...new Set(notImported.filter(Boolean))], errors };
}

// ───────────────────────────── the diff ─────────────────────────────

/** A stable fingerprint of what was confirmed: the same entries ⇒ the same batch, whatever order they arrive in. */
export function batchOf(entries: DiffEntry[]): string {
  const canon = [...entries]
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    .map((e) => ({ m: e.model, k: e.kind, n: e.name, b: e.before?.qty ?? null, a: e.after?.qty ?? null, d: e.delta, f: [...e.fields].sort((x, y) => (x.field < y.field ? -1 : 1)) }));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 32);
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

export function computeDiff(sheet: ParsedSheet, current: StockProduct[]): Diff {
  const byModel = new Map(current.map((p) => [p.model.toLowerCase(), p]));
  const entries: DiffEntry[] = [];
  const flags: DiffFlag[] = sheet.rows
    .filter((r) => r.other !== null)
    .map((r) => ({ model: r.model, row: r.row, message: `Other branch not supported yet — value ${r.other} not imported` }));
  const inSheet = new Set<string>();
  let unchanged = 0;
  for (const r of sheet.rows) {
    inSheet.add(r.model.toLowerCase());
    const p = byModel.get(r.model.toLowerCase());
    if (!p) {
      const fields: FieldChange[] = [{ field: "name", before: null, after: r.name }];
      if (r.priceMinor != null) fields.push({ field: "priceMinor", before: null, after: r.priceMinor });
      if (r.category) fields.push({ field: "category", before: null, after: r.category });
      if (r.commissionGroup) fields.push({ field: "commissionGroup", before: null, after: r.commissionGroup });
      if (r.note) fields.push({ field: "note", before: null, after: r.note });
      const qty = r.qty ?? 0;
      entries.push({ model: r.model, kind: "new", itemId: null, name: r.name, before: null, after: { qty }, delta: qty, fields });
      continue;
    }
    const fields: FieldChange[] = [];
    if (!same(p.name, r.name)) fields.push({ field: "name", before: p.name, after: r.name });
    if (r.priceMinor !== undefined && !same(p.priceMinor, r.priceMinor)) fields.push({ field: "priceMinor", before: p.priceMinor, after: r.priceMinor });
    if (r.category !== undefined && !same(p.category, r.category)) fields.push({ field: "category", before: p.category, after: r.category });
    if (r.commissionGroup !== undefined && !same(p.commissionGroup, r.commissionGroup)) fields.push({ field: "commissionGroup", before: p.commissionGroup, after: r.commissionGroup });
    if (r.note !== undefined && !same(p.note, r.note)) fields.push({ field: "note", before: p.note, after: r.note });
    const before = p.qty ?? 0;
    const delta = r.qty === null ? 0 : r.qty - before;
    if (delta === 0 && !fields.length) { unchanged++; continue; }
    entries.push({
      model: p.model, kind: delta !== 0 ? "qty_change" : "field_change", itemId: p.id, name: r.name,
      before: { qty: p.qty }, after: { qty: delta !== 0 ? before + delta : p.qty }, delta, fields,
    });
  }
  for (const p of current) {
    if (inSheet.has(p.model.toLowerCase())) continue;
    entries.push({ model: p.model, kind: "removed", itemId: p.id, name: p.name, before: { qty: p.qty }, after: null, delta: 0, fields: [] });
  }
  entries.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return { entries, unchanged, notImported: sheet.notImported, flags, batch: batchOf(entries) };
}

// ───────────────────────────── the apply plan ─────────────────────────────

export interface PlannedMovement { model: string; qty: number; reason: string; idempotencyKey: string }

export class StockImportRefusal extends Error {
  constructor(
    public code: "NEGATIVE_BALANCE" | "STALE" | "BAD_DIFF",
    message: string,
    public model?: string,
    public item?: string,
    public resultingBalance?: number,
  ) { super(message); }
}

// ───────────────────────────── the screen's envelope ─────────────────────────────

/** `before` / `after` as the FE reads them: only what changes (plus the balance when it changes). A side that does not exist is `{}`. */
export interface RowSide { name?: string | null; priceSatang?: number | null; quantity?: number | null; category?: string | null; commissionGroup?: string | null }
export interface PreviewRow { model: string; name: string; kind: DiffKind; before: RowSide; after: RowSide; delta: number }

const sideKey: Record<FieldName, keyof RowSide | null> = { name: "name", priceMinor: "priceSatang", category: "category", commissionGroup: "commissionGroup", note: null };

export function previewRows(entries: DiffEntry[]): PreviewRow[] {
  return entries.map((e) => {
    const before: RowSide = {};
    const after: RowSide = {};
    if (e.kind === "removed") { before.name = e.name; before.quantity = e.before?.qty ?? null; }
    else {
      if (e.delta !== 0 || e.kind === "new") { before.quantity = e.before?.qty ?? null; after.quantity = e.after?.qty ?? null; }
      for (const f of e.fields) { const k = sideKey[f.field]; if (!k) continue; (before as Record<string, unknown>)[k] = f.before; (after as Record<string, unknown>)[k] = f.after; }
    }
    return { model: e.model, name: e.name, kind: e.kind, before, after, delta: e.delta };
  });
}

/**
 * THE below-zero rule of every stock write (the import's apply AND the Stock OUT sale — one definition, never two): a balance `current` plus a signed `delta` that would
 * be negative is refused with `NEGATIVE_BALANCE` naming the item and the number it would become. Returns the resulting balance otherwise.
 */
export function refuseIfNegative(model: string, name: string, current: number, delta: number): number {
  const resulting = current + delta;
  if (resulting < 0) throw new StockImportRefusal("NEGATIVE_BALANCE", `«${model}» จะติดลบ (${current} ${delta >= 0 ? "+" : ""}${delta} = ${resulting})`, model, name, resulting);
  return resulting;
}

// ───────────────────────────── the revenue category (DECISIONS row 21) ─────────────────────────────

export interface RevenueCat { id: string; type: string; name: string }
/** The category every product the sheet cannot place falls into (the import creates it if it is missing), so day-one sales are never blocked. */
export const DEFAULT_REVENUE_CATEGORY = { type: "SALES", name: "Product sales" } as const;
const REVENUE_MATCH_TYPES = new Set(["SALES", "FNB", "OTHER"]);

/** The sheet's Type → a revenue category of a PRODUCT type (SALES / FNB / OTHER) by name, case-insensitive. Zero hits, or the same name under two types (ambiguous), ⇒ null (the default + a flag). */
export function matchRevenueCategory(label: string | null | undefined, cats: RevenueCat[]): RevenueCat | null {
  const k = (label ?? "").trim().toLowerCase();
  if (!k) return null;
  const hits = cats.filter((c) => REVENUE_MATCH_TYPES.has(c.type) && c.name.trim().toLowerCase() === k);
  return hits.length === 1 ? hits[0] : null;
}

export const movementKey = (batch: string, model: string) => `stock-import:${batch}:${model}`;

/**
 * What the confirmed diff would write, checked against the shop's NOW. Refuses the WHOLE apply (nothing is partly written):
 *   • a `removed` entry is never acted on (it is skipped, not an error);
 *   • an entry that names an item the shop no longer has, or whose `before` balance is not the balance now ⇒ STALE (the preview is old);
 *   • a balance that would go negative ⇒ NEGATIVE_BALANCE naming the item;
 *   • a `new` whose code now exists ⇒ STALE.
 */
export function planApply(entries: DiffEntry[], current: StockProduct[]): { movements: PlannedMovement[]; batch: string } {
  const byModel = new Map(current.map((p) => [p.model.toLowerCase(), p]));
  const acted = entries.filter((e) => e.kind !== "removed");
  const batch = batchOf(entries);
  const movements: PlannedMovement[] = [];
  const seen = new Set<string>();
  for (const e of acted) {
    const key = e.model.toLowerCase();
    if (seen.has(key)) throw new StockImportRefusal("BAD_DIFF", `Model Code «${e.model}» ซ้ำในรายการที่ยืนยัน`, e.model);
    seen.add(key);
    if (!Number.isInteger(e.delta)) throw new StockImportRefusal("BAD_DIFF", `delta ของ «${e.model}» ต้องเป็นจำนวนเต็ม`, e.model);
    const p = byModel.get(key);
    if (e.kind === "new") {
      if (p) throw new StockImportRefusal("STALE", `«${e.model}» มีในระบบแล้ว — ให้ preview ใหม่`, e.model);
      if (e.delta < 0) throw new StockImportRefusal("NEGATIVE_BALANCE", `«${e.model}» ยอดเปิดต้องไม่ติดลบ`, e.model, e.name, e.delta);
    } else {
      if (!p) throw new StockImportRefusal("STALE", `ไม่พบ «${e.model}» ในระบบ — ให้ preview ใหม่`, e.model);
      // the NEGATIVE check is first: a balance sold down since the preview that would now go below zero is a NEGATIVE_BALANCE (the screen's code), not a generic STALE
      refuseIfNegative(e.model, p.name, p.qty ?? 0, e.delta);
      if ((e.before?.qty ?? null) !== (p.qty ?? null)) throw new StockImportRefusal("STALE", `ยอดของ «${e.model}» เปลี่ยนไปแล้วหลัง preview — ให้ preview ใหม่`, e.model);
    }
    if (e.delta !== 0)
      movements.push({ model: e.model, qty: e.delta, reason: e.kind === "new" ? "Opening balance (stock import)" : "Stock import adjustment", idempotencyKey: movementKey(batch, e.model) });
  }
  return { movements, batch };
}
