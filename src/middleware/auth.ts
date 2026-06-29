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
