import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import * as svc from "../services/teacher-sync.service";
import { serviceAuth } from "../middleware/auth";

// SPEC-004 / TASK-015 — machine-only (serviceAuth) teacher-sync bridge for scheduling.
// Mounted under v1 as /internal/teacher-sync/*. Every call is idempotent (find-by-ref / set-state).
export const teacherSyncRoutes = new Hono()
  .post("/onboard", serviceAuth, zValidator("json", v.teacherSyncOnboard), async (c) => {
    const { externalRef, displayName } = c.req.valid("json");
    const org = c.req.query("org");
    return c.json(await svc.syncOnboard(externalRef, displayName, org ?? undefined));
  })
  .post("/update", serviceAuth, zValidator("json", v.teacherSyncUpdate), async (c) => {
    const { externalRef, displayName, active } = c.req.valid("json");
    const org = c.req.query("org");
    return c.json(await svc.syncUpdate(externalRef, { displayName, active }, org ?? undefined));
  })
  .post("/offboard", serviceAuth, zValidator("json", v.teacherSyncOffboard), async (c) => {
    const { externalRef, effectiveMonth } = c.req.valid("json");
    const org = c.req.query("org");
    return c.json(await svc.syncOffboard(externalRef, effectiveMonth, org ?? undefined));
  })
  .post("/switch-type", serviceAuth, zValidator("json", v.teacherSyncSwitchType), async (c) => {
    const { externalRef, effectiveMonth } = c.req.valid("json");
    const org = c.req.query("org");
    return c.json(await svc.syncSwitchType(externalRef, effectiveMonth, org ?? undefined));
  });
