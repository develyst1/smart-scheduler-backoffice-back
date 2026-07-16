import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/reports.service";

export const reportRoutes = new Hono().get(
  "/pl",
  zValidator("query", v.plReportQuery),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(await svc.getPLReport({ orgCode: q.org, from: q.from, to: q.to }));
  },
);
