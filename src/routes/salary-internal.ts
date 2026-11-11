// 🔻 TASK-887 (SPEC-102 §5-E4, the FINAL remind ↔ send contract A) — the INTERNAL read smart-scheduler-back's pay-confirm reminders call:
//   GET /api/v1/internal/salary/unconfirmed?date=YYYY-MM-DD  →  { periodId, lockAt, teacherIds }  (draft slips only)  |  { periodId: null }
// 🔒 FAIL-CLOSED machine auth: the `X-Service-Token` header must equal a NON-EMPTY `SERVICE_TOKEN`. (The older `serviceAuth` lets every request through when the env is unset — fine for a dev stub, not for a route that names coaches.) No user token opens it.
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { unauthorized } from "../lib/http";
import { configuredServiceToken } from "../middleware/auth"; // 🔻 TASK-896: a placeholder token counts as unset
import { createSalaryService, type SalaryService } from "../services/salary.service";
import { dbSalaryStore } from "../services/salary-db.store";
import { unconfirmedForDate } from "../services/slip-confirm.service";

function sameToken(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function strictServiceToken(c: Context, next: Next) {
  if (!sameToken(c.req.header("X-Service-Token"), configuredServiceToken())) throw unauthorized("Invalid service token");
  await next();
}

/** `service` is injectable so the route is testable without a database. */
export function makeInternalSalaryRoutes(service: SalaryService) {
  return new Hono().use("*", strictServiceToken).get("/unconfirmed", async (c) => c.json(await unconfirmedForDate(service, c.req.query("date") ?? "")));
}
export const internalSalaryRoutes = makeInternalSalaryRoutes(createSalaryService(dbSalaryStore));
