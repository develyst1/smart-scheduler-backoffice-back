// /api/v1/salary — the thin-slip pay-run + slip engine (SPEC-100 §5 / TASK-865). CEO-ONLY: `requireRole("ceo")` on EVERY route.
//
// 💰 MONEY OVER HTTP IS INTEGER SATANG (1 baht = 100): `baseAmount`, `total`, `amount`, `baseSalary` are integers
// (signed for lines). The CSV export is baht with 2 decimals. Never a float.
//
//   GET    /salary/periods                      → [{id, year, month, status, lockAt, lockedAt}]
//   POST   /salary/periods {year, month}        → the period · 409 PERIOD_EXISTS
//   POST   /salary/periods/:id/run              → {created, refreshed} · 409 LOCKED
//   GET    /salary/periods/:id                  → {period, slips:[{id, teacherId, baseAmount, total, status}]}   (month overview)
//   GET    /salary/slips/:id                    → {id, period, teacherId, baseAmount, status, lines:[{id, kind, label, amount, source}], total}
//   POST   /salary/slips/:id/lines {amount,label} → the line · 400 empty reason / zero amount · 409 LOCKED
//   DELETE /salary/slips/:id/lines/:lineId      → 204 · 409 LOCKED
//   POST   /salary/periods/:id/lock             → the locked period
//   GET    /salary/periods/:id/export           → text/csv (teacher_id,base_salary,total,status)
//   GET    /salary/profiles · PUT /salary/profiles/:teacherId {employmentType, baseSalary, active, roles?, meritEligible?, vehicle?}
//          profile = {teacherId, employmentType, roles (effective, never empty; one role or exactly PT+FL), baseSalary, active, meritEligible, vehicle}
//   GET    /salary/profiles/:teacherId/fl-rates         → [{classType, rate}]  (private|duo|group|eca|camp; rate = integer satang PER HOUR)
//   PUT    /salary/profiles/:teacherId/fl-rates/:classType {rate} → {classType, rate} · 404 unknown person · 400 bad classType / rate
//   (TASK-871) every period also carries `periodStart` / `periodEnd` (YYYY-MM-DD, inclusive; the R1.4 range "30/9–30/10"; null on rows made before it).

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireRole } from "../middleware/auth";
import { ApiException, notFound } from "../lib/http";
import { createSalaryService, type SalaryService } from "../services/salary.service";
import { dbSalaryStore } from "../services/salary-db.store";
import { exportSlip } from "../services/slip-export.service"; // 🔻 TASK-879
import { applyBonusLinesFor } from "../services/bonus-lines.service"; // 🔻 TASK-867
import { applyCommissionLinesFor } from "../services/commission-lines.service"; // 🔻 TASK-921
import { buildDailyReport } from "../services/daily-report.service"; // 🔻 TASK-885
import { buildPayReport, buildTeachingReport, payXlsxFor, periodIdOf, teachingXlsxFor } from "../services/salary-reports.service"; // 🔻 TASK-922
import { confirmMySlipFor, remindPeriodFor } from "../services/slip-confirm.service"; // 🔻 TASK-887
import { transportServiceFor } from "../services/transport.service"; // 🔻 TASK-868
import { transportRoutesFor } from "./transport"; // 🔻 TASK-868

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id is "not found", never a database error. */
const uuid = (v: string | undefined, what: string): string => {
  if (!v || !UUID.test(v)) throw notFound(what);
  return v;
};

const createPeriodBody = z.object({ year: z.number().int(), month: z.number().int() });
const lineBody = z.object({ amount: z.number().int(), label: z.string() });
const profileBody = z.object({
  employmentType: z.enum(["FT", "PT", "FL", "STAFF"]),
  baseSalary: z.number().int().nullable(),
  active: z.boolean(),
  // TASK-871 (optional: omitted ⇒ the stored value stays)
  roles: z.array(z.enum(["FT", "PT", "FL", "STAFF"])).optional(),
  meritEligible: z.boolean().optional(),
  vehicle: z.enum(["car", "motorbike"]).nullable().optional(),
});
const otBody = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), minutes: z.number().int() });
const meritBody = z.object({ amount: z.number().int(), label: z.string().optional() });
const confirmBody = z.object({ year: z.number().int(), month: z.number().int() }); // 🔻 TASK-887 (nothing else is read from the body)
const mySlipQuery = z.object({ year: z.coerce.number().int(), month: z.coerce.number().int() });
const entryBody = z.object({ teacherId: z.string(), year: z.number().int(), month: z.number().int(), kind: z.string(), amountSatang: z.number().int(), label: z.string().optional(), reason: z.string().optional() });
const flRateBody = z.object({ rate: z.number().int() });

const ceo = requireRole("ceo");

/** `service` is injectable so the routes are testable without a database. */
export function makeSalaryRoutes(service: SalaryService) {
  return new Hono()
    .route("/transport", transportRoutesFor(service)) // 🔻 TASK-868: schools + trips, ceo OR admin (the gate is inside the sub-router)
    // 🔻 TASK-880 / SPEC-102 E1: a coach reads ONLY their own slip. Any signed-in role passes the gate; the SLIP IS RESOLVED BY THE TOKEN's teacherId,
    // never by anything the caller supplies. No teacherId on the token (e.g. an admin / the dev ceo) -> 403 NO_TEACHER. No slip -> 200 {slip:null}.
    .get("/my-slip", requireRole("ceo", "admin", "coach"), zValidator("query", mySlipQuery), async (c) => {
      const teacherId = c.get("user").teacherId;
      if (!teacherId) throw new ApiException(403, "NO_TEACHER", "This account has no coach salary slip");
      const { year, month } = c.req.valid("query");
      return c.json(await service.mySlip(teacherId, year, month));
    })
    // 🔻 TASK-887 / SPEC-102 E4a: the coach confirms their OWN slip (draft → confirmed). The slip comes from the TOKEN's teacherId only; the body is {year, month}. 403 NO_TEACHER · 404 NO_SLIP · 409 LOCKED. Logic: services/slip-confirm.service.ts
    .post("/my-slip/confirm", requireRole("ceo", "admin", "coach"), zValidator("json", confirmBody), async (c) => c.json(await confirmMySlipFor(service, c.get("user"), c.req.valid("json"))))
    // 🔻 TASK-880 / SPEC-102 E2: the ADMIN-BLIND entry. Admin only (the CEO has POST /slips/:id/lines). The response is the created line ONLY.
    // 🔻 TASK-886 / SPEC-102 E2b: the admin-safe people picker. Names + meritEligible ONLY - no pay of any kind; active, never is_system.
    .get("/entries/people", requireRole("admin", "ceo"), async (c) => c.json(await service.listEntriesPeople()))
    .post("/entries", requireRole("admin"), zValidator("json", entryBody), async (c) => {
      const b = c.req.valid("json");
      return c.json(await service.addEntry({ ...b, teacherId: uuid(b.teacherId, "Coach not found") }, c.get("user").sub), 201);
    })
    // 🔻 TASK-885 (R1.7): the Daily Training Report — per day, each coach's hours and that day's derived pay. CEO only, read-only. Logic: services/daily-report.service.ts
    .get("/daily", ceo, async (c) => c.json(await buildDailyReport(c.req.query("date") ?? "", service)))
    // 🔻 TASK-922 (R1.8): the month-end SALARY reports — (A) teaching per coach (no money), (B) salary + other income per person, each as JSON and as Excel. CEO only, read-only. Logic: services/salary-reports.service.ts
    .get("/reports/teaching", ceo, async (c) => c.json(await buildTeachingReport(periodIdOf(c.req.query("periodId"), uuid), service)))
    .get("/reports/pay", ceo, async (c) => c.json(await buildPayReport(periodIdOf(c.req.query("periodId"), uuid), service)))
    .get("/reports/teaching.xlsx", ceo, async (c) => teachingXlsxFor(periodIdOf(c.req.query("periodId"), uuid), service))
    .get("/reports/pay.xlsx", ceo, async (c) => payXlsxFor(periodIdOf(c.req.query("periodId"), uuid), service))
    // 🔻 TASK-887 / SPEC-102 E4b: the CEO "remind now" - the unconfirmed list (names + draft/none, no pay) + SB's send result. Logic: services/slip-confirm.service.ts
    .post("/periods/:id/remind", ceo, async (c) => c.json(await remindPeriodFor(service, uuid(c.req.param("id"), "Pay period not found"))))
    .get("/periods", ceo, async (c) => c.json(await service.listPeriods()))
    .post("/periods", ceo, zValidator("json", createPeriodBody), async (c) => {
      const { year, month } = c.req.valid("json");
      return c.json(await service.createPeriod(year, month), 201);
    })
    .post("/periods/:id/run", ceo, async (c) => c.json(await service.runPeriod(uuid(c.req.param("id"), "Pay period not found"))))
    // 🔻 TASK-867 (Brew, Team C): Bonus 50 / 100 candidates → auto pay lines. Idempotent; 409 LOCKED on a locked period. Logic: services/bonus-lines.service.ts
    .post("/periods/:id/apply-bonus", ceo, async (c) => c.json(await applyBonusLinesFor(service, uuid(c.req.param("id"), "Pay period not found"), c.get("user").sub)))
    // 🔻 TASK-868 (Brew, Team C): trips → transport auto pay lines. CEO only. Idempotent; 409 LOCKED. Logic: services/transport.service.ts
    .post("/periods/:id/apply-transport", ceo, async (c) => c.json(await transportServiceFor(service).applyTransportLines(uuid(c.req.param("id"), "Pay period not found"), c.get("user").sub)))
    // 🔻 TASK-921 (Bob, Team B): the period's product-sale lines → Commission pay lines (own shares + the FT pool). CEO only. 409 LOCKED. Logic: services/commission-lines.service.ts
    .post("/periods/:id/apply-commission", ceo, async (c) => c.json(await applyCommissionLinesFor(service, uuid(c.req.param("id"), "Pay period not found"), c.get("user").sub)))
    .get("/periods/:id", ceo, async (c) => c.json(await service.getPeriod(uuid(c.req.param("id"), "Pay period not found"))))
    .post("/periods/:id/lock", ceo, async (c) => c.json(await service.lockPeriod(uuid(c.req.param("id"), "Pay period not found"))))
    .get("/periods/:id/export", ceo, async (c) => {
      const { filename, body } = await service.exportCsv(uuid(c.req.param("id"), "Pay period not found"));
      return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` } });
    })
    // 🔻 TASK-879: Payment Detail export of one slip. CEO only (never admin / coach). Logic: services/slip-export.service.ts + lib/slip-sections.ts
    .get("/slips/:id/export.xlsx", ceo, async (c) => exportSlip(await service.getSlip(uuid(c.req.param("id"), "Slip not found")), "xlsx"))
    .get("/slips/:id/export.pdf", ceo, async (c) => exportSlip(await service.getSlip(uuid(c.req.param("id"), "Slip not found")), "pdf"))
    .get("/slips/:id", ceo, async (c) => c.json(await service.getSlip(uuid(c.req.param("id"), "Slip not found"))))
    .post("/slips/:id/lines", ceo, zValidator("json", lineBody), async (c) => {
      const actor = c.get("user").sub;
      return c.json(await service.addLine(uuid(c.req.param("id"), "Slip not found"), c.req.valid("json"), actor), 201);
    })
    .post("/slips/:id/ot", ceo, zValidator("json", otBody), async (c) => {
      const actor = c.get("user").sub;
      return c.json(await service.addOt(uuid(c.req.param("id"), "Slip not found"), c.req.valid("json"), actor), 201);
    })
    .post("/slips/:id/merit", ceo, zValidator("json", meritBody), async (c) => {
      const actor = c.get("user").sub;
      return c.json(await service.addMerit(uuid(c.req.param("id"), "Slip not found"), c.req.valid("json"), actor), 201);
    })
    .delete("/slips/:id/lines/:lineId", ceo, async (c) => {
      await service.removeLine(uuid(c.req.param("id"), "Slip not found"), uuid(c.req.param("lineId"), "Line not found"));
      return c.body(null, 204);
    })
    .get("/profiles", ceo, async (c) => c.json(await service.listProfiles()))
    .put("/profiles/:teacherId", ceo, zValidator("json", profileBody), async (c) =>
      c.json(await service.setProfile(uuid(c.req.param("teacherId"), "Coach not found"), c.req.valid("json"))),
    )
    .get("/profiles/:teacherId/fl-rates", ceo, async (c) => c.json(await service.getFlRates(uuid(c.req.param("teacherId"), "Coach not found"))))
    .put("/profiles/:teacherId/fl-rates/:classType", ceo, zValidator("json", flRateBody), async (c) =>
      c.json(await service.setFlRate(uuid(c.req.param("teacherId"), "Coach not found"), c.req.param("classType") ?? "", c.req.valid("json").rate)),
    );
}

export const salaryRoutes = makeSalaryRoutes(createSalaryService(dbSalaryStore));
