import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as items from "../services/item.service";
import * as tags from "../services/tag.service";
import * as revenue from "../services/revenue.service";
import { adminAuth } from "../middleware/auth";

// REQ-006 / TASK-022 — the rebuilt backoffice API on the universal `bo` model. Mounted under
// /api/v1/bo/* so it coexists with the dormant ops routes (REQ-001/002 are still live on ops).
// Writes behind the single-admin JWT (adminAuth, REQ-002); reads open (like the old ops GETs).
export const boRoutes = new Hono()
  // ── Items ──
  .get("/items", zValidator("query", v.listBoItemsQuery), async (c) =>
    c.json({ items: await items.listItems(c.req.valid("query")) }),
  )
  .post("/items", adminAuth, zValidator("json", v.createBoItem), async (c) =>
    c.json(await items.createItem(c.req.valid("json")), 201),
  )
  .get("/items/:id", async (c) => c.json(await items.getItem(c.req.param("id"))))
  .patch("/items/:id", adminAuth, zValidator("json", v.updateBoItem), async (c) =>
    c.json(await items.updateItem(c.req.param("id"), c.req.valid("json"))),
  )
  // ── Movements ──
  .post("/items/:id/movements", adminAuth, zValidator("json", v.boMovementBody), async (c) =>
    c.json(await items.applyMovement(c.req.param("id"), c.req.valid("json")), 201),
  )
  .get("/items/:id/movements", zValidator("query", v.boListMovementsQuery), async (c) =>
    c.json({ items: await items.listMovements(c.req.param("id"), c.req.valid("query").limit) }),
  )
  // ── Item tags ──
  .put("/items/:id/tags", adminAuth, zValidator("json", v.setItemTags), async (c) =>
    c.json(await tags.setItemTags(c.req.param("id"), c.req.valid("json").tagValueIds)),
  )
  // ── Tag groups / values ──
  .get("/tag-groups", async (c) => c.json({ groups: await tags.listTagGroups() }))
  .post("/tag-groups", adminAuth, zValidator("json", v.createTagGroup), async (c) =>
    c.json(await tags.createTagGroup(c.req.valid("json")), 201),
  )
  .post("/tag-values", adminAuth, zValidator("json", v.createTagValue), async (c) =>
    c.json(await tags.createTagValue(c.req.valid("json")), 201),
  )
  // ── P&L report ──
  .get("/reports/pl", zValidator("query", v.boPlQuery), async (c) =>
    c.json(await items.getPLReport(c.req.valid("query"))),
  )
  // ── Revenue reports (SPEC-021 / TASK-064). Read-only; no writes, no migration.
  //    ⚠️ Behind `adminAuth`, unlike `/reports/pl` above — see the task notes. REQ-014 is explicitly
  //    "executive-only", and customer-spend pairs a student's name with what their family has paid.
  .get("/reports/revenue-by-activity", adminAuth, zValidator("query", v.revenueByActivityQuery), async (c) =>
    c.json(await revenue.getRevenueByActivity(c.req.valid("query").month)),
  )
  .get("/reports/customer-spend", adminAuth, zValidator("query", v.customerSpendQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json(await revenue.getCustomerSpend(q.month, q.q));
  });
