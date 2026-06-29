import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/pricing.service";
import { adminAuth } from "../middleware/auth";

export const pricingRoutes = new Hono()
  .get("/rules", zValidator("query", v.listPriceRulesQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json({
      items: await svc.listPriceRules({
        orgCode: q.org,
        partyId: q.partyId,
        orgDefault: q.orgDefault,
      }),
    });
  })
  .post("/rules", adminAuth, zValidator("json", v.createPriceRule), async (c) => {
    const body = c.req.valid("json");
    const org = c.req.query("org");
    return c.json(await svc.createPriceRule(body, org ?? undefined), 201);
  })
  .get("/rules/:id", async (c) => c.json(await svc.getPriceRule(c.req.param("id"))));
