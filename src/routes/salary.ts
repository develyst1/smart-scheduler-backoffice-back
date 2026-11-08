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
import { notFound } from "../lib/http";
import { createSalaryService, type SalaryService } from "../services/salary.service";
import { dbSalaryStore } from "../services/salary-db.store";

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
const flRateBody = z.object({ rate: z.number().int() });

const ceo = requireRole("ceo");

/** `service` is injectable so the routes are testable without a database. */
export function makeSalaryRoutes(service: SalaryService) {
  return new Hono()
    .get("/periods", ceo, async (c) => c.json(await service.listPeriods()))
    .post("/periods", ceo, zValidator("json", createPeriodBody), async (c) => {
      const { year, month } = c.req.valid("json");
      return c.json(await service.createPeriod(year, month), 201);
    })
    .post("/periods/:id/run", ceo, async (c) => c.json(await service.runPeriod(uuid(c.req.param("id"), "ไม่พบงวดเงินเดือน"))))
    .get("/periods/:id", ceo, async (c) => c.json(await service.getPeriod(uuid(c.req.param("id"), "ไม่พบงวดเงินเดือน"))))
    .post("/periods/:id/lock", ceo, async (c) => c.json(await service.lockPeriod(uuid(c.req.param("id"), "ไม่พบงวดเงินเดือน"))))
    .get("/periods/:id/export", ceo, async (c) => {
      const { filename, body } = await service.exportCsv(uuid(c.req.param("id"), "ไม่พบงวดเงินเดือน"));
      return new Response(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` } });
    })
    .get("/slips/:id", ceo, async (c) => c.json(await service.getSlip(uuid(c.req.param("id"), "ไม่พบสลิป"))))
    .post("/slips/:id/lines", ceo, zValidator("json", lineBody), async (c) => {
      const actor = c.get("user").sub;
      return c.json(await service.addLine(uuid(c.req.param("id"), "ไม่พบสลิป"), c.req.valid("json"), actor), 201);
    })
    .post("/slips/:id/ot", ceo, zValidator("json", otBody), async (c) => {
      const actor = c.get("user").sub;
      return c.json(await service.addOt(uuid(c.req.param("id"), "ไม่พบสลิป"), c.req.valid("json"), actor), 201);
    })
    .post("/slips/:id/merit", ceo, zValidator("json", meritBody), async (c) => {
      const actor = c.get("user").sub;
      return c.json(await service.addMerit(uuid(c.req.param("id"), "ไม่พบสลิป"), c.req.valid("json"), actor), 201);
    })
    .delete("/slips/:id/lines/:lineId", ceo, async (c) => {
      await service.removeLine(uuid(c.req.param("id"), "ไม่พบสลิป"), uuid(c.req.param("lineId"), "ไม่พบรายการ"));
      return c.body(null, 204);
    })
    .get("/profiles", ceo, async (c) => c.json(await service.listProfiles()))
    .put("/profiles/:teacherId", ceo, zValidator("json", profileBody), async (c) =>
      c.json(await service.setProfile(uuid(c.req.param("teacherId"), "ไม่พบครู"), c.req.valid("json"))),
    )
    .get("/profiles/:teacherId/fl-rates", ceo, async (c) => c.json(await service.getFlRates(uuid(c.req.param("teacherId"), "ไม่พบครู"))))
    .put("/profiles/:teacherId/fl-rates/:classType", ceo, zValidator("json", flRateBody), async (c) =>
      c.json(await service.setFlRate(uuid(c.req.param("teacherId"), "ไม่พบครู"), c.req.param("classType") ?? "", c.req.valid("json").rate)),
    );
}

export const salaryRoutes = makeSalaryRoutes(createSalaryService(dbSalaryStore));
