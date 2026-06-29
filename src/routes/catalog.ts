import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/inventory.service";
import { adminAuth, serviceAuth } from "../middleware/auth";

export const catalogRoutes = new Hono()
  .get("/", zValidator("query", v.orgCodeQuery), async (c) => {
    const { org } = c.req.valid("query");
    return c.json({ items: await svc.listCatalogItems(org) });
  })
  .post("/", adminAuth, zValidator("json", v.createCatalogItem), async (c) => {
    const body = c.req.valid("json");
    const org = c.req.query("org");
    const item = await svc.createCatalogItem(body, org ?? undefined);
    return c.json(item, 201);
  })
  .get("/:id", async (c) => c.json(await svc.getCatalogItem(c.req.param("id"))))
  .post(
    "/:id/movements",
    serviceAuth,
    zValidator("json", v.stockMovement),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(await svc.applyStockMovement(c.req.param("id"), body), 201);
    },
  )
  .get("/:id/movements", zValidator("query", v.listMovementsQuery), async (c) => {
    const { limit } = c.req.valid("query");
    return c.json({
      items: await svc.listStockMovements(c.req.param("id"), limit),
    });
  });

export const commerceRoutes = new Hono().post(
  "/sales",
  serviceAuth,
  zValidator("json", v.createSale),
  async (c) => {
    const body = c.req.valid("json");
    const org = c.req.query("org");
    return c.json(await svc.createSale(body, org ?? undefined), 201);
  },
);
