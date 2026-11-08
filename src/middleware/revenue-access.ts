import type { Context, Next } from "hono";
import { requireRole } from "./auth";

/**
 * SPEC-098 §1.6 — the ONE gate on every revenue route (R0.1 / §9.4 #6: revenue is CEO-only).
 * No token → 401 `UNAUTHORIZED`; a signed-in admin or coach → 403 `FORBIDDEN`; a ceo passes.
 *
 * `requireRole` already authenticates (SPEC-097 §4), so `requireAuth` in front of it would verify the token twice
 * for the same result; this is the SPEC's "requireAuth then requireRole('ceo')" in one step.
 *
 * A real named function, not an alias: the route test finds the gate by `handler.name === "requireRevenueAccess"`.
 */
const ceoOnly = requireRole("ceo");

export async function requireRevenueAccess(c: Context, next: Next) {
  return ceoOnly(c, next);
}

/**
 * SPEC-099 §8.5 / TASK-874 — the gate on the payment-record routes (`/revenue/payments`): a ceo OR an admin. An admin
 * records payments but must never see a revenue figure (R0.2), so these routes return payment rows only — no revenue
 * line, no total. A coach is 403; no token is 401. Every OTHER revenue route keeps `requireRevenueAccess` (ceo-only).
 */
const ceoOrAdmin = requireRole("ceo", "admin");

export async function requirePaymentAccess(c: Context, next: Next) {
  return ceoOrAdmin(c, next);
}
