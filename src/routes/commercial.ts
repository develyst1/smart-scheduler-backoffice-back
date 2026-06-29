import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/commercial.service";
import { adminAuth } from "../middleware/auth";

export const commercialRoutes = new Hono()
  .get("/requests", zValidator("query", v.listCommercialQuery), async (c) => {
    const { status } = c.req.valid("query");
    return c.json({ items: await svc.listCommercialRequests(status) });
  })
  .post("/requests", adminAuth, zValidator("json", v.createCommercialRequest), async (c) => {
    return c.json(await svc.createCommercialRequest(c.req.valid("json")), 201);
  })
  .get("/requests/:id", async (c) => c.json(await svc.getCommercialRequest(c.req.param("id"))))
  .patch(
    "/requests/:id",
    adminAuth,
    zValidator("json", v.reviewCommercialRequest),
    async (c) => {
      return c.json(
        await svc.reviewCommercialRequest(c.req.param("id"), c.req.valid("json")),
      );
    },
  );
