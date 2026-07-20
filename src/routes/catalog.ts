import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/inventory.service";
import { adminAuth, adminOrService } from "../middleware/auth";

export const catalogRoutes = new Hono()
  .get("/", zValidator("query", v.listCatalogQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json({
      items: await svc.listCatalogItems({
        orgCode: q.org,
        externalSource: q.externalSource,
        externalRef: q.externalRef,
        itemType: q.itemType,
      }),
    });
  })
  .post("/", adminAuth, zValidator("json", v.createCatalogItem), async (c) => {
    const body = c.req.valid("json");
    const org = c.req.query("org");
    const item = await svc.createCatalogItem(body, org ?? undefined);
    return c.json(item, 201);
  })
  // Decrement an item by its upstream ref (scheduling calls this). Static path — declared
  // before /:id/movements so "by-ref" isn't captured as an id.
  .post("/by-ref/movements", adminOrService, zValidator("json", v.movementByRef), async (c) => {
    const { org, externalSource, externalRef, ...movement } = c.req.valid("json");
    return c.json(
      await svc.applyStockMovementByExternal(externalSource, externalRef, movement, org),
      201,
    );
  })
  .get("/:id", async (c) => c.json(await svc.getCatalogItem(c.req.param("id"))))
  .patch("/:id", adminOrService, zValidator("json", v.updateCatalogItem), async (c) =>
    c.json(await svc.updateCatalogItem(c.req.param("id"), c.req.valid("json"))),
  )
  .post(
    "/:id/movements",
    adminOrService,
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
  adminOrService,
  zValidator("json", v.createSale),
  async (c) => {
    const body = c.req.valid("json");
    const org = c.req.query("org");
    return c.json(await svc.createSale(body, org ?? undefined), 201);
  },
);
