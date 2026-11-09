// /api/v1/stock — the Stock foundation (TASK-904).
//
//   GET  /stock/products?q=            → [{ id, code, name, category, priceSatang, quantity, commissionGroup: {name, amountSatang}|null, active }]   ceo + admin
//   POST /stock/import/preview         multipart `file` (.xlsx, ≤ 5 MB) → { batchId, rows:[{model,name,kind,before,after,delta}], notImported[], flags[], unchanged }   CEO ONLY · STAGES the diff server-side (30 min), writes NOTHING to the database · a bad cell/header is a 400 listing them
//   POST /stock/import/apply  { batchId }  → { batchId, movementsWritten, itemsAdded, fieldEdits, removedLeft, alreadyApplied? }   CEO ONLY · no file, no diff from the client
//        409 NEGATIVE_BALANCE {error:{code,message,details:{model,name,resultingBalance}}} (nothing written) · 409 STALE (the balances moved since the preview) · 404 BATCH_NOT_FOUND (expired / unknown: preview again) · a batch already applied writes nothing
// The movement report (`GET /bo/stock/movements`) lives in `routes/bo.ts` next to the other `bo` reads.
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { adminAuth, requireRole } from "../middleware/auth";
import { badRequest } from "../lib/http";
import { SALES_LIMIT_MAX, listProducts, listRevenueCategories, listSales } from "../services/stock-read.service";
import { stockOutService } from "../services/stock-out.service"; // 🔻 TASK-909
import { lowStockService } from "../services/low-stock.service"; // 🔻 TASK-919
import { stockWriteService } from "../services/stock-write.service"; // 🔻 TASK-911
import { MAX_UPLOAD_BYTES, stockImportService } from "../services/stock-import.service";

// 🔻 TASK-909 — Stock OUT. The cart is validated here (shape, integers, ranges); the service re-checks the rules that need the database.
const money = z.number().int().min(0).max(1_000_000_000);
export const stockOutBody = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_:.-]{8,100}$/),
  soldAt: z.string().max(40).refine((s) => !Number.isNaN(new Date(s).getTime()), "soldAt must be an ISO date").optional(),
  sellerRefs: z.array(z.string().min(1).max(64)).max(20).optional(),
  branch: z.enum(["BRAVO", "OTHER"]).optional(),
  method: z.enum(["TRANSFER", "CASH", "CARD"]).optional(),
  buyerRef: z.string().max(100).optional(),
  remark: z.string().max(500).optional(),
  lines: z
    .array(z.object({ itemId: z.string().uuid(), qty: z.number().int().min(1).max(100_000), unitPriceSatang: money, discountSatang: money.optional(), commissionSatang: money.optional() }))
    .min(1)
    .max(200),
});

// 🔻 TASK-911 - the product create / edit and Stock IN bodies (the service re-checks the rules that need the database).
const satang = z.number().int().min(0).max(1_000_000_000);
export const productCreateBody = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  category: z.string().max(100).nullable(),
  priceSatang: satang,
  commissionGroup: z.string().max(100).nullable(),
  active: z.boolean(),
  openingQuantity: z.number().int().min(0).max(1_000_000),
  revenueCategoryId: z.string().uuid(), // 🔻 row 21: REQUIRED on create - a product with none is born un-sellable (the sale returns 400 NO_REVENUE_CATEGORY)
});
export const productPatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  priceSatang: satang.optional(),
  category: z.string().max(100).nullable().optional(),
  commissionGroup: z.string().max(100).nullable().optional(),
  active: z.boolean().optional(),
  revenueCategoryId: z.string().uuid().optional(), // can change, never cleared
});
export const stockInBody = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_:.-]{8,100}$/),
  receivedOn: z.string().regex(/^d{4}-d{2}-d{2}$/),
  lines: z.array(z.object({ itemId: z.string().uuid(), qty: z.number().int().min(1).max(1_000_000) })).min(1).max(200),
});

/** The ONLY thing apply takes: the staged batch's id (the sha256-derived hex the preview returned). The diff is never sent back by the client. */
export const applyBody = z.object({ batchId: z.string().regex(/^[0-9a-f]{32}$/) });

export const lowStockBody = z.object({ thresholds: z.record(z.string(), z.unknown()) }); // 🔻 TASK-919 — the shape only; every level is validated by `parseThresholds` (a 400 listing each problem)

// 🔻 TASK-928 (R3.8) — the Sales History query (the window is checked by the service: real days, from ≤ to, ≤ 366 days).
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const salesQuery = z.object({
  from: z.string().regex(DAY_RE),
  to: z.string().regex(DAY_RE),
  q: z.string().max(100).optional(),
  customer: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(SALES_LIMIT_MAX).default(200),
});

export const stockRoutes = new Hono()
  // 🔻 TASK-928 — Sales History: ceo + admin, qty only, NO money anywhere (the screen shows none): { items:[{id, saleId, occurredOn, itemId, code, name, qty, customer, payment, branch}], customers:[…] }.
  .get("/sales", adminAuth, zValidator("query", salesQuery), async (c) => c.json(await listSales(c.req.valid("query"))))
  // 🔻 TASK-919 (R3.7) — Low Stock. The list and the thresholds are readable by ceo + admin; the thresholds are EDITED by the CEO only. No money in any of it.
  .get("/low-stock", adminAuth, async (c) => c.json(await lowStockService.lowList()))
  .get("/low-stock/thresholds", adminAuth, async (c) => c.json({ thresholds: await lowStockService.getThresholds() }))
  .put("/low-stock/thresholds", adminAuth, zValidator("json", lowStockBody), async (c) => {
    const user = c.get("user") as { sub?: string } | undefined;
    return c.json({ thresholds: await lowStockService.setThresholds(c.req.valid("json").thresholds, user?.sub ?? null) });
  })
  // 🔻 TASK-909 — sell a cart (ceo + admin). The response carries NO revenue / commission totals (an admin sees none).
  .post("/out", adminAuth, zValidator("json", stockOutBody), async (c) => {
    const user = c.get("user") as { sub?: string } | undefined;
    return c.json(await stockOutService.sell(c.req.valid("json"), user?.sub ?? null)); // a NEGATIVE_BALANCE / STALE / … ApiException falls through to the app's onError: {error:{code,message,details}}
  })
  // 🔻 TASK-911 - Stock IN (ceo + admin): one STOCK_IN movement per line, NO cost / price, idempotent on the key; occurred_on = receivedOn.
  .post("/in", adminAuth, zValidator("json", stockInBody), async (c) => {
    const user = c.get("user") as { sub?: string } | undefined;
    return c.json(await stockWriteService.stockIn(c.req.valid("json"), user?.sub ?? null));
  })
  // 🔻 TASK-911 - create / edit a product (CEO). Create seeds ONE opening movement; edit is a field edit (no movement, balance untouched).
  .post("/products", requireRole("ceo"), zValidator("json", productCreateBody), async (c) => c.json(await stockWriteService.createProduct(c.req.valid("json"), (c.get("user") as { sub?: string } | undefined)?.sub ?? null), 201))
  .patch("/products/:id", requireRole("ceo"), zValidator("json", productPatchBody), async (c) => {
    const id = c.req.param("id") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw badRequest("id ไม่ถูกต้อง");
    return c.json(await stockWriteService.editProduct(id, c.req.valid("json")));
  })
  // 🔻 TASK-909 — the product form's category picker (ceo + admin; the revenue route is CEO-only): { categories: [{id, type, name}] }
  .get("/revenue-categories", adminAuth, async (c) => c.json(await listRevenueCategories()))
  .get("/products", adminAuth, zValidator("query", z.object({ q: z.string().max(100).optional() })), async (c) =>
    c.json(await listProducts(c.req.valid("query").q)),
  )
  .post("/import/preview", requireRole("ceo"), async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_UPLOAD_BYTES + 64 * 1024) throw badRequest("ไฟล์ใหญ่เกิน 5 MB");
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw badRequest("ต้องส่งเป็น multipart/form-data");
    }
    const file = form.file;
    if (!(file instanceof File)) throw badRequest("ต้องแนบไฟล์ในฟิลด์ «file»");
    if (file.size > MAX_UPLOAD_BYTES) throw badRequest("ไฟล์ใหญ่เกิน 5 MB");
    return c.json(await stockImportService.preview(new Uint8Array(await file.arrayBuffer())));
  })
  .post("/import/apply", requireRole("ceo"), zValidator("json", applyBody), async (c) =>
    c.json(await stockImportService.apply(c.req.valid("json").batchId)),
  ); // errors (NEGATIVE_BALANCE {model,name,resultingBalance} · STALE · BATCH_NOT_FOUND) all fall through to the app's onError: {error:{code,message,details}}
