// /api/v1/salary/transport — TASK-868 (REQ-120 R1.2 / R1.6, SPEC-100 §9b): schools, trips. Mounted by ONE line in the salary router.
//
// Who: a ceo OR an admin (R0: admins enter items). `requireRole("ceo", "admin")` on EVERY route. An ADMIN's trip responses carry NO
// ฿ amount and no vehicle (R0.2: an admin never sees pay) — decided by `tripDTO`'s whitelist in the service, not here. A coach is 403.
//
//   GET    /salary/transport/schools                      → [{id, name, distanceKm, active}]
//   POST   /salary/transport/schools {name, distanceKm, active?}   → 201 school · 409 SCHOOL_EXISTS · 400
//   PUT    /salary/transport/schools/:id {name?, distanceKm?, active?} → school · 404 · 409 SCHOOL_EXISTS
//   GET    /salary/transport/trips?periodId=<uuid>&teacherId=<uuid>?   → [trip]   (the period's R1.4 date range)
//   POST   /salary/transport/trips {teacherId, date, schoolId, roundTrip, km?, note?} → 201 trip · 409 LOCKED
//   PUT    /salary/transport/trips/:id {date?, schoolId?, roundTrip?, km?, note?}     → trip · 404 · 409 LOCKED
//   DELETE /salary/transport/trips/:id                                          → 204 · 404 · 409 LOCKED
//   trip   = CEO: {id, teacherId, date, schoolId, schoolName, roundTrip, km, vehicle, note, amountSatang|null}
//            ADMIN: {id, teacherId, date, schoolId, schoolName, roundTrip, km, note}      (no vehicle, no amount)
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireRole } from "../middleware/auth";
import { badRequest, notFound } from "../lib/http";
import type { SalaryService } from "../services/salary.service";
import { transportServiceFor, type TransportService, type Viewer } from "../services/transport.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id is "not found", never a database error. */
const uuid = (v: string | undefined, what: string): string => {
  if (!v || !UUID.test(v)) throw notFound(what);
  return v;
};

// A failure is the app's own 400 `VALIDATION` body, not zValidator's default shape (as revenue-ledger.ts).
const zv = <T extends "json" | "query", S extends z.ZodType>(target: T, schema: S) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      throw badRequest(`${issue?.path.join(".") || target}: ${issue?.message ?? "invalid"}`, result.error.issues);
    }
  });

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const KM = z.number().positive().max(9999.99);
const schoolBody = z.object({ name: z.string().min(1).max(120), distanceKm: KM, active: z.boolean().optional() });
const schoolPatch = z
  .object({ name: z.string().min(1).max(120).optional(), distanceKm: KM.optional(), active: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.distanceKm !== undefined || b.active !== undefined, "send at least one of name, distanceKm, active");
const tripQuery = z.object({ periodId: z.string().uuid(), teacherId: z.string().uuid().optional() });
const tripBody = z.object({
  teacherId: z.string().uuid(),
  date: DATE,
  schoolId: z.string().uuid(),
  roundTrip: z.boolean(),
  km: KM.optional(),
  note: z.string().max(500).nullable().optional(),
});
const tripPatch = z
  .object({ date: DATE.optional(), schoolId: z.string().uuid().optional(), roundTrip: z.boolean().optional(), km: KM.optional(), note: z.string().max(500).nullable().optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "send at least one field");

const staff = requireRole("ceo", "admin");

/** The viewer of a request that already passed the gate (ceo or admin). */
const viewerOf = (c: { get: (k: "user") => { role: string } }): Viewer => (c.get("user").role === "ceo" ? "ceo" : "admin");

/** `service` is injectable so the routes are testable without a database. */
export function makeTransportRoutes(service: TransportService) {
  return new Hono()
    .get("/schools", staff, async (c) => c.json(await service.listSchools()))
    .post("/schools", staff, zv("json", schoolBody), async (c) => c.json(await service.createSchool(c.req.valid("json")), 201))
    .put("/schools/:id", staff, zv("json", schoolPatch), async (c) => c.json(await service.updateSchool(uuid(c.req.param("id"), "School not found"), c.req.valid("json"))))
    .get("/trips", staff, zv("query", tripQuery), async (c) => c.json(await service.listTrips(c.req.valid("query"), viewerOf(c))))
    .post("/trips", staff, zv("json", tripBody), async (c) => c.json(await service.createTrip(c.req.valid("json"), c.get("user").sub, viewerOf(c)), 201))
    .put("/trips/:id", staff, zv("json", tripPatch), async (c) => c.json(await service.updateTrip(uuid(c.req.param("id"), "Trip not found"), c.req.valid("json"), viewerOf(c))))
    .delete("/trips/:id", staff, async (c) => {
      await service.deleteTrip(uuid(c.req.param("id"), "Trip not found"));
      return c.body(null, 204);
    });
}

/** The production wiring, on Jason's salary service. The salary router mounts this with ONE line. */
export const transportRoutesFor = (salary: SalaryService) => makeTransportRoutes(transportServiceFor(salary));
