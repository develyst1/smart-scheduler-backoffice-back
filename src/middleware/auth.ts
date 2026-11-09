import type { Context, Next } from "hono";
import { forbidden, unauthorized } from "../lib/http";
import { verifyToken, type AuthClaims, type Role } from "../lib/jwt";

// Make c.get("user") / c.set("user", …) / c.var.user type-safe everywhere.
declare module "hono" {
  interface ContextVariableMap {
    user: AuthClaims;
  }
}

/**
 * Service token check for machine consumers (e.g. the scheduling API). 🔒 FAILS CLOSED (TASK-890): an unset / empty SERVICE_TOKEN used to let every request through, leaving
 * teacher-sync, accounts debits and recurring open to anyone. Now: the dev bypass (SKIP_ADMIN_AUTH=true, like adminOrService) passes; otherwise there must be a configured token
 * AND the request must carry it.
 */
/** 🔒 TASK-896 - values that ship in `.env.example` / the repo's `.env` as stand-ins. They are SET, known and guessable, so they count as NOT configured. One list: add a future placeholder here. */
export const PLACEHOLDER_SERVICE_TOKENS: readonly string[] = ["change-me-service-token"];

/** The service token to enforce, or `undefined` when none is really configured (unset, empty, or a placeholder). Every machine-auth check goes through this. */
export function configuredServiceToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const t = env.SERVICE_TOKEN;
  return t && !PLACEHOLDER_SERVICE_TOKENS.includes(t) ? t : undefined;
}

export async function serviceAuth(c: Context, next: Next) {
  if (process.env.SKIP_ADMIN_AUTH === "true") {
    await next();
    return;
  }
  const expected = configuredServiceToken();
  if (!expected) throw unauthorized("service token ไม่ได้ตั้งค่า");
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.header("X-Service-Token");
  if (token !== expected) throw unauthorized("service token ไม่ถูกต้อง");
  await next();
}

const skipAuth = () => process.env.SKIP_ADMIN_AUTH === "true";
const bearerOf = (c: Context): string => {
  const header = c.req.header("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

/** What a request is when `SKIP_ADMIN_AUTH=true` and carries no usable token (dev only): the most permissive role, so a
 *  developer can reach every gate. A valid Bearer still WINS, so role behaviour can be exercised in dev. */
const DEV_USER: AuthClaims = { sub: "dev", role: "ceo", teacherId: null };

/** Sets `c.var.user` from the request, or throws 401. The one place a token becomes a user. */
async function authenticate(c: Context): Promise<AuthClaims> {
  const token = bearerOf(c);
  if (skipAuth()) {
    let user: AuthClaims = DEV_USER;
    if (token) {
      try {
        user = await verifyToken(token);
      } catch {
        /* dev bypass: an unusable token is the dev user, as the old single-admin gate let it through */
      }
    }
    c.set("user", user);
    return user;
  }
  if (!token) throw unauthorized("ต้อง login");
  try {
    const user = await verifyToken(token);
    c.set("user", user);
    return user;
  } catch {
    throw unauthorized("โทเคนไม่ถูกต้องหรือหมดอายุ");
  }
}

/** SPEC-097 §4 — any signed-in user (ceo / admin / coach). Sets `c.var.user = {sub, role, teacherId}`. 401 otherwise. */
export async function requireAuth(c: Context, next: Next) {
  await authenticate(c);
  await next();
}

/**
 * SPEC-097 §4 — signed in AND one of `roles`, else 403 `FORBIDDEN`. The middleware gates the ROUTE; hiding a FIELD
 * from an admin (R0.2) is the handler's job. Revenue (Team C) uses `requireRole("ceo")`.
 */
export function requireRole(...roles: Role[]) {
  return async function requireRole(c: Context, next: Next) {
    const user = await authenticate(c);
    if (!roles.includes(user.role)) throw forbidden();
    await next();
  };
}

/** The staff gate the existing routes already use (kept under its name — `bo.test.ts` walks the route table for it):
 *  signed in as a ceo or an admin. A coach is 403 (they see only their own slip, never the item / stock surface). */
export async function adminAuth(c: Context, next: Next) {
  const user = await authenticate(c);
  if (user.role !== "ceo" && user.role !== "admin") throw forbidden();
  await next();
}

/** Endpoints that BOTH a human (ceo / admin, backoffice FE) and a machine (scheduling) may call —
 *  e.g. stock movements & sales. Passes if a valid service token OR a valid ceo/admin JWT is present. */
export async function adminOrService(c: Context, next: Next) {
  if (skipAuth()) {
    await next();
    return;
  }
  const bearer = bearerOf(c) || undefined;
  const expected = configuredServiceToken(); // 🔻 TASK-896: the placeholder never opens this door
  const svcToken = c.req.header("X-Service-Token") ?? bearer;
  if (expected && svcToken === expected) {
    await next(); // machine consumer with a valid service token
    return;
  }
  if (bearer) {
    let user: AuthClaims;
    try {
      user = await verifyToken(bearer);
    } catch {
      throw unauthorized("โทเคนไม่ถูกต้องหรือหมดอายุ");
    }
    if (user.role !== "ceo" && user.role !== "admin") throw forbidden();
    c.set("user", user);
    await next();
    return;
  }
  throw unauthorized("ต้อง login หรือใช้ service token");
}
