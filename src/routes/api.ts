import { Hono } from "hono";
import { authRoutes } from "./auth";
import { boRoutes } from "./bo";
import { revenueLedgerRoutes } from "./revenue-ledger";
import { salaryRoutes } from "./salary";
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
  // SPEC-097 — who am I (any signed-in role). The FE reads it on load; also the login round-trip's second leg.
  // It lives here, not under `/auth`: only `/auth/login` is public (the front office learned that the hard way, TASK-383).
  .get("/me", requireAuth, (c) => {
    const u = c.get("user");
    return c.json({ user: { username: u.sub, role: u.role, teacherId: u.teacherId ?? null } });
  });

export const api = new Hono().route("/v1", v1);
