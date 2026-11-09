// /api/v1/demo - Stock DEMO (TASK-915, REQ-120 R3.6): teaching equipment at sites, separate from the sale stock. CEO + ADMIN (no money exists here, so it is admin-safe).
//
//   GET  /demo/sites                         → { sites: [{ id, name, sortOrder }] }                                   left to right
//   GET  /demo/stock?q=&category=            → { sites, items: [{ id, category, name, remark, saleItemId, balances: { [siteId]: qty }, total }] }   ACTIVE items
//   GET  /demo/movements?from&to&siteId&type&q&limit → { items: [{ id, occurredOn, who, itemId, itemName, type, qty, from, to, reason }] }   newest first; from/to inclusive, <= 366 days
//   POST /demo/move       { key, itemId, fromSiteId, toSiteId, qty, reason, occurredOn? }     → { occurredOn, balances, movementsWritten, alreadyApplied? }   409 NEGATIVE_BALANCE
//   POST /demo/defect-in  { key, itemId, toSiteId, qty, reason, occurredOn? }                 → same   (a plain +qty from «Defect Product»; nothing leaves sale stock)
//   POST /demo/delete     { key, itemId, reason, siteId?, qty?, occurredOn? }                 → same   (write-off; no siteId/qty = zero every site AND deactivate the item)
//   POST /demo/sites      { name }  → 201 the site · 409 DUPLICATE_SITE        PUT /demo/sites/order { ids[] } → { ids }   (exactly the active sites)
// Every write is one locked transaction, idempotent on `key` (a repeat answers alreadyApplied and writes nothing). Errors: the app's { error: { code, message, details } }.
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { adminAuth } from "../middleware/auth";
import { DEMO_MOVEMENT_TYPES } from "../db/schema-demo";
import { demoService, listDemoMovements, listDemoSites, listDemoStock } from "../services/demo-stock.service";

const uuid = z.string().uuid();
const key = z.string().regex(/^[A-Za-z0-9_.-]{8,100}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const qty = z.number().int().min(1).max(1_000_000);
const reason = z.string().min(1).max(500);

export const demoMoveBody = z.object({ key, itemId: uuid, fromSiteId: uuid, toSiteId: uuid, qty, reason, occurredOn: day.optional() });
export const demoDefectBody = z.object({ key, itemId: uuid, toSiteId: uuid, qty, reason, occurredOn: day.optional() });
export const demoDeleteBody = z.object({ key, itemId: uuid, reason, siteId: uuid.optional(), qty: qty.optional(), occurredOn: day.optional() });
export const demoSiteBody = z.object({ name: z.string().min(1).max(60) });
export const demoSiteOrderBody = z.object({ ids: z.array(uuid).min(1).max(100) });
const stockQuery = z.object({ q: z.string().max(100).optional(), category: z.string().max(100).optional() });
const movementQuery = z.object({
  from: day,
  to: day,
  siteId: uuid.optional(),
  type: z.enum(DEMO_MOVEMENT_TYPES).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const actorOf = (c: { get: (k: "user") => unknown }): string | null => (c.get("user") as { sub?: string } | undefined)?.sub ?? null;

export const demoRoutes = new Hono()
  .get("/sites", adminAuth, async (c) => c.json(await listDemoSites()))
  .get("/stock", adminAuth, zValidator("query", stockQuery), async (c) => c.json(await listDemoStock(c.req.valid("query"))))
  .get("/movements", adminAuth, zValidator("query", movementQuery), async (c) => c.json(await listDemoMovements(c.req.valid("query"))))
  .post("/move", adminAuth, zValidator("json", demoMoveBody), async (c) => c.json(await demoService.move(c.req.valid("json"), actorOf(c))))
  .post("/defect-in", adminAuth, zValidator("json", demoDefectBody), async (c) => c.json(await demoService.defectIn(c.req.valid("json"), actorOf(c))))
  .post("/delete", adminAuth, zValidator("json", demoDeleteBody), async (c) => c.json(await demoService.remove(c.req.valid("json"), actorOf(c))))
  .post("/sites", adminAuth, zValidator("json", demoSiteBody), async (c) => c.json(await demoService.addSite(c.req.valid("json").name), 201))
  .put("/sites/order", adminAuth, zValidator("json", demoSiteOrderBody), async (c) => c.json(await demoService.orderSites(c.req.valid("json").ids)));
