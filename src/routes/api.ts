import { Hono } from "hono";
import { authRoutes } from "./auth";
import { boRoutes } from "./bo";
import { revenueLedgerRoutes } from "./revenue-ledger";
import { salaryRoutes } from "./salary";
import { internalSalaryRoutes } from "./salary-internal"; // 🔻 TASK-887
import { stockRoutes } from "./stock"; // 🔻 TASK-904
import { internalJobsRoutes } from "./internal-jobs"; // 🔻 TASK-919
import { demoRoutes } from "./demo"; // 🔻 TASK-915
import { notificationRoutes } from "./notifications"; // 🔻 TASK-917
import { reportsRoutes } from "./reports"; // 🔻 TASK-924
import { requireAuth } from "../middleware/auth";

/**
 * Versioned API. REQ-006 rebuild (TASK-027): the backoffice now serves ONLY the universal `bo` model +
 * auth. The old `ops.*` routes are **retired** — backoffice-back runs on the shared `smart_scheduler` DB
 * where no `ops.*` tables exist, so those routes would 500. Their route/service files stay dormant
 * (unimported) and get deleted in a later cleanup.
 */
export const v1 = new Hono()
  .route("/auth", authRoutes)
  .route("/bo", boRoutes)
  // SPEC-098 / TASK-858 — the revenue ledger (CEO-only through `requireRevenueAccess`).
  .route("/revenue", revenueLedgerRoutes)
  // SPEC-100 / TASK-865 — the thin-slip pay-run + slip engine (CEO-only: `requireRole("ceo")` on every route).
  .route("/salary", salaryRoutes)
  // 🔻 TASK-904 — the Stock foundation: products (ceo + admin) and the git-style import (CEO only).
  .route("/stock", stockRoutes)
  // 🔻 TASK-915 — Stock DEMO (R3.6): teaching equipment at sites, separate from the sale stock (ceo + admin; no money).
  .route("/demo", demoRoutes)
  // 🔻 TASK-917 — in-web notifications (R0.4): the caller's own feed + mark-read; recipients / coaches read-only for the CEO (ruling C-h: no opt-out).
  .route("/notifications", notificationRoutes)
  // 🔻 TASK-924 / SPEC-103 — the All Report API (STUDENT here; COURSE + REPORT = TASK-926): /api/v1/reports/*, ceo + admin, money CEO-only.
  .route("/reports", reportsRoutes)
  // 🔻 TASK-887 (the FINAL remind ↔ send contract, A) — the INTERNAL read smart-scheduler-back's reminders call: /api/v1/internal/salary/unconfirmed, behind a FAIL-CLOSED X-Service-Token guard (no user token opens it).
  .route("/internal/salary", internalSalaryRoutes)
  // 🔻 TASK-919 — the Monday Low-Stock job's endpoint: /api/v1/internal/jobs/low-stock-weekly, behind the same FAIL-CLOSED X-Service-Token guard.
  .route("/internal/jobs", internalJobsRoutes)
  // SPEC-097 — who am I (any signed-in role). The FE reads it on load; also the login round-trip's second leg.
  // It lives here, not under `/auth`: only `/auth/login` is public (the front office learned that the hard way, TASK-383).
  .get("/me", requireAuth, (c) => {
    const u = c.get("user");
    return c.json({ user: { username: u.sub, role: u.role, teacherId: u.teacherId ?? null } });
  });

export const api = new Hono().route("/v1", v1);
