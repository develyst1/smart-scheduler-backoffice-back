import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as items from "../services/item.service";
import * as tags from "../services/tag.service";
import * as revenue from "../services/revenue.service";
import { adminAuth } from "../middleware/auth";

// REQ-006 / TASK-022 — the rebuilt backoffice API on the universal `bo` model. Mounted under /api/v1/bo/*.
//
// 🔐 **EVERY route here — reads included — is behind the single-admin JWT (`adminAuth`, REQ-002).**
//
// This replaces the previous rule, "writes guarded, reads open (like the old ops GETs)" (TASK-068). That
// default was inherited from a catalogue API, and it did not survive contact with what this surface actually
// serves: the P&L, item prices, freelance ceilings (a teacher's pay rate), and money movement history.
// REQ-014's entire access-control answer is *"finance is executive-only because it lives on the backoffice"* —
// which was **false at the API level** while any unauthenticated caller who could reach :4010 could read the
// business's P&L. **An API is not protected by the UI in front of it.**
//
// ⚠️ If you add a route here, it gets `adminAuth` unless you can name a caller that legitimately cannot send
// a token — and then say so in a comment, rather than leaving the gap for someone to infer a rule from.
// Verified before the sweep: every backoffice-front call goes through the axios instance that attaches the
// JWT on **every** request, and no service/script consumes these routes.
export const boRoutes = new Hono()
  // ── Items ── prices (`unitPriceMinor`) and freelance ceilings (a teacher's rate + remaining budget).
  .get("/items", adminAuth, zValidator("query", v.listBoItemsQuery), async (c) =>
    c.json({ items: await items.listItems(c.req.valid("query")) }),
  )
  .post("/items", adminAuth, zValidator("json", v.createBoItem), async (c) =>
    c.json(await items.createItem(c.req.valid("json")), 201),
  )
  // Destructured rather than `param("id")`: with a middleware and no zValidator, Hono widens the param
  // lookup to `string | undefined`. The record form keeps it typed off the path.
  .get("/items/:id", adminAuth, async (c) => {
    const { id } = c.req.param();
    return c.json(await items.getItem(id));
  })
  .patch("/items/:id", adminAuth, zValidator("json", v.updateBoItem), async (c) =>
    c.json(await items.updateItem(c.req.param("id"), c.req.valid("json"))),
  )
  // ── Movements ── money history: every sale and every freelance drawdown, with amounts.
  .post("/items/:id/movements", adminAuth, zValidator("json", v.boMovementBody), async (c) =>
    c.json(await items.applyMovement(c.req.param("id"), c.req.valid("json")), 201),
  )
  .get("/items/:id/movements", adminAuth, zValidator("query", v.boListMovementsQuery), async (c) =>
    c.json({ items: await items.listMovements(c.req.param("id"), c.req.valid("query").limit) }),
  )
  // ── Item tags ──
  .put("/items/:id/tags", adminAuth, zValidator("json", v.setItemTags), async (c) =>
    c.json(await tags.setItemTags(c.req.param("id"), c.req.valid("json").tagValueIds)),
  )
  // ── Tag groups / values ── not financial in itself, but it is backoffice configuration with no anonymous
  //    consumer, so it follows the rule above rather than becoming the one exception someone later cites.
  .get("/tag-groups", adminAuth, async (c) => c.json({ groups: await tags.listTagGroups() }))
  .post("/tag-groups", adminAuth, zValidator("json", v.createTagGroup), async (c) =>
    c.json(await tags.createTagGroup(c.req.valid("json")), 201),
  )
  .post("/tag-values", adminAuth, zValidator("json", v.createTagValue), async (c) =>
    c.json(await tags.createTagValue(c.req.valid("json")), 201),
  )
  // ── P&L report ── the route this task exists for.
  .get("/reports/pl", adminAuth, zValidator("query", v.boPlQuery), async (c) =>
    c.json(await items.getPLReport(c.req.valid("query"))),
  )
  // ── Revenue reports (SPEC-021 / TASK-064). Read-only; no writes, no migration.
  .get("/reports/revenue-by-activity", adminAuth, zValidator("query", v.revenueByActivityQuery), async (c) =>
    c.json(await revenue.getRevenueByActivity(c.req.valid("query").month)),
  )
  .get("/reports/customer-spend", adminAuth, zValidator("query", v.customerSpendQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json(await revenue.getCustomerSpend(q.month, q.q));
  });
