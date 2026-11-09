import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requirePaymentAccess } from "../middleware/revenue-access";
import { badRequest } from "../lib/http";
import { daysBetween, isValidDate, MAX_RANGE_DAYS } from "../lib/revenue-ledger";
import { reportCourses, type ReportRole } from "../services/reports-courses.service";
import { reportOverview } from "../services/reports-overview.service";
import { reportStudents } from "../services/reports-students.service";

// 🔻 TASK-924 / SPEC-103 — the All Report API, mounted at /api/v1/reports. READ-ONLY.
// 🔐 EVERY route is behind `requirePaymentAccess` (CEO + admin). Money is CEO-only: each service omits its money keys
// (absent, not zeroed) when `role` is "admin" — the route only passes the caller's role through.
// (This file replaced the old unmounted P&L `reportRoutes` stub, which nothing imported.)
const zv = <T extends "query", S extends z.ZodType>(target: T, schema: S) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      throw badRequest(`${issue?.path.join(".") || target}: ${issue?.message ?? "invalid"}`, result.error.issues);
    }
  });

const date = z.string().refine(isValidDate, "must be a real date, YYYY-MM-DD");
const branch = z.enum(["BRAVO", "OTHER"]);

const studentsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ALL"]).default("ACTIVE"),
  subjectId: z.string().uuid().optional(),
});

const coursesQuery = z
  .object({ from: date, to: date, branch: branch.optional() })
  .refine((v) => v.from <= v.to, { message: "from must not be after to", path: ["from"] })
  .refine((v) => daysBetween(v.from, v.to) <= MAX_RANGE_DAYS, { message: `range is at most ${MAX_RANGE_DAYS} days`, path: ["to"] });

const overviewQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be YYYY-MM"),
  branch: branch.optional(),
});

const roleOf = (c: { get: (k: "user") => { role: string } }): ReportRole => (c.get("user").role === "ceo" ? "ceo" : "admin");

export const reportsRoutes = new Hono()
  .get("/students", requirePaymentAccess, zv("query", studentsQuery), async (c) => c.json(await reportStudents(c.req.valid("query"))))
  .get("/courses", requirePaymentAccess, zv("query", coursesQuery), async (c) => c.json(await reportCourses(c.req.valid("query"), roleOf(c as never))))
  .get("/overview", requirePaymentAccess, zv("query", overviewQuery), async (c) => c.json(await reportOverview(c.req.valid("query"), roleOf(c as never))));
