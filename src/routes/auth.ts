// Auth routes (SPEC-003) — public, mounted before/independent of the admin guards.
// Phase-1 single-admin login: credentials from env (ADMIN_USERNAME/PASSWORD, dev fallback
// admin/admin). Mirrors smart-scheduler-back/src/routes/auth.ts; same token contract.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import { signToken } from "../lib/jwt";
import { unauthorized } from "../lib/http";

export const authRoutes = new Hono().post("/login", zValidator("json", v.login), async (c) => {
  const { username, password } = c.req.valid("json");
  const expectedUser = process.env.ADMIN_USERNAME ?? "admin";
  const expectedPass = process.env.ADMIN_PASSWORD ?? "admin";
  if (username !== expectedUser || password !== expectedPass)
    throw unauthorized("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");

  const token = await signToken({ sub: username, role: "admin" });
  return c.json({ token, user: { username, role: "admin" as const } });
});
