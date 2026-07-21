import type { Context, Next } from "hono";
import { unauthorized } from "../lib/http";
import { verifyToken, type AuthClaims } from "../lib/jwt";

// Make c.get("user") / c.set("user", …) type-safe everywhere.
declare module "hono" {
  interface ContextVariableMap {
    user: AuthClaims;
  }
}

/** Dev-friendly service token check for machine consumers (e.g. scheduling API). */
export async function serviceAuth(c: Context, next: Next) {
  const expected = process.env.SERVICE_TOKEN;
  if (!expected) {
    await next();
    return;
  }
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : c.req.header("X-Service-Token");
  if (token !== expected) throw unauthorized("service token ไม่ถูกต้อง");
  await next();
}

/** Admin JWT gate (SPEC-003). `SKIP_ADMIN_AUTH=true` (dev) bypasses. Otherwise a valid Bearer
 *  login token is required — missing/invalid/expired → 401. Claims attach to `c.get("user")`. */
export async function adminAuth(c: Context, next: Next) {
  if (process.env.SKIP_ADMIN_AUTH === "true") {
    await next();
    return;
  }
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw unauthorized("ต้อง login admin");
  try {
    c.set("user", await verifyToken(token));
  } catch {
    throw unauthorized("โทเคนไม่ถูกต้องหรือหมดอายุ");
  }
  await next();
}

/** Endpoints that BOTH a human admin (backoffice FE) and a machine (scheduling) may call —
 *  e.g. stock movements & sales. Passes if a valid service token OR a valid admin JWT is present. */
export async function adminOrService(c: Context, next: Next) {
  if (process.env.SKIP_ADMIN_AUTH === "true") {
    await next();
    return;
  }
  const header = c.req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  const expected = process.env.SERVICE_TOKEN;
  const svcToken = c.req.header("X-Service-Token") ?? bearer;
  if (expected && svcToken === expected) {
    await next(); // machine consumer with a valid service token
    return;
  }
  if (bearer) {
    try {
      c.set("user", await verifyToken(bearer)); // admin JWT
    } catch {
      throw unauthorized("โทเคนไม่ถูกต้องหรือหมดอายุ");
    }
    await next();
    return;
  }
  throw unauthorized("ต้อง login admin หรือใช้ service token");
}
