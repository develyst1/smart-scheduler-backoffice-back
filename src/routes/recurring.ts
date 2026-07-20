import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/recurring.service";
import { adminAuth, serviceAuth } from "../middleware/auth";

// SPEC-002 / TASK-005 — effective-dated FT/PT salary schedule.
export const recurringCostRoutes = new Hono()
  .get("/", zValidator("query", v.listRecurringCostsQuery), async (c) => {
    const q = c.req.valid("query");
    return c.json({
      items: await svc.listRecurringCosts({
        orgCode: q.org,
        externalSource: q.externalSource,
        externalRef: q.externalRef,
      }),
    });
  })
  .post("/", adminAuth, zValidator("json", v.setRecurringCost), async (c) => {
    const org = c.req.query("org");
    return c.json(await svc.setRecurringCost(c.req.valid("json"), org ?? undefined), 201);
  });

// Internal, service-token-guarded jobs (invoked by the monthly scheduler, not the FE).
export const internalRoutes = new Hono()
  .post("/recurring/materialize", serviceAuth, zValidator("json", v.materializeBody), async (c) => {
    const org = c.req.query("org");
    return c.json(await svc.materializeRecurring(c.req.valid("json").month, org ?? undefined));
  })
  .post("/jobs/month-start", serviceAuth, zValidator("json", v.monthStartBody), async (c) => {
    const org = c.req.query("org");
    return c.json(await svc.runMonthStart(c.req.valid("json").month, org ?? undefined));
  });
