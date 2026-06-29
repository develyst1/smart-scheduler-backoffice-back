import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/parties.service";
import { adminAuth } from "../middleware/auth";

export const partyRoutes = new Hono()
  .get("/", zValidator("query", v.listPartiesQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json({ items: await svc.listParties(q) });
  })
  .post("/", adminAuth, zValidator("json", v.createParty), async (c) => {
    const body = c.req.valid("json");
    const org = c.req.query("org");
    return c.json(await svc.createParty(body, org ?? undefined), 201);
  })
  .get("/:id", async (c) => c.json(await svc.getParty(c.req.param("id"))));
