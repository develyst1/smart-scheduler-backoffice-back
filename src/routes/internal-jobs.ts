// /api/v1/internal/jobs — the host's scheduled jobs for the back office (TASK-919: the Monday Low-Stock run). NOT auto-registered anywhere: the owner registers the Task Scheduler entry
// (`sm-jobs/low-stock-weekly.ps1`). FAIL-CLOSED: the shared `X-Service-Token` guard of the internal salary routes — an unset / empty SERVICE_TOKEN, a missing or wrong header and any user Bearer are all 401.
import { Hono } from "hono";
import { strictServiceToken } from "./salary-internal";
import { lowStockService } from "../services/low-stock.service";

export const internalJobsRoutes = new Hono()
  .use("*", strictServiceToken)
  // Computes the low-stock list and posts ONE «Low Stock» notification per recipient, once per ISO week (a re-run the same week writes nothing; nothing low ⇒ nothing written).
  .post("/low-stock-weekly", async (c) => c.json(await lowStockService.runWeekly()));
