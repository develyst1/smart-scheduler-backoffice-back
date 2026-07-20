import type { Context, Next } from "hono";
import { forbidden, unauthorized } from "../lib/http";

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

/** Placeholder for admin JWT — wire when backoffice FE auth exists. */
export async function adminAuth(c: Context, next: Next) {
  if (process.env.SKIP_ADMIN_AUTH === "true") {
    await next();
    return;
  }
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) throw forbidden("ต้อง login admin");
  // TODO: verify JWT against JWT_SECRET
  await next();
}

/** Endpoints that BOTH a human admin (backoffice FE) and a machine (scheduling) may call —
 *  e.g. stock movements & sales. Passes if the admin gate OR the service-token gate passes. */
export async function adminOrService(c: Context, next: Next) {
  if (process.env.SKIP_ADMIN_AUTH === "true") {
    await next();
    return;
  }
  const header = c.req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const expected = process.env.SERVICE_TOKEN;
  const svcToken = c.req.header("X-Service-Token") ?? bearer;
  if (expected && svcToken === expected) {
    await next(); // machine consumer with a valid service token
    return;
  }
  if (header?.startsWith("Bearer ")) {
    await next(); // admin JWT (stub — real verify lands with backoffice login)
    return;
  }
  throw unauthorized("ต้อง login admin หรือใช้ service token");
}
