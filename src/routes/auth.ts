// Auth routes (SPEC-003, SPEC-097 / TASK-856) — public, mounted before/independent of the guards.
// `POST /login` validates against `bo.users` and returns `{ token, user: { username, role, teacherId } }`.
// The Phase-1 single-admin env login (ADMIN_USERNAME / ADMIN_PASSWORD, dev fallback admin/admin) survives ONLY under
// `SKIP_ADMIN_AUTH=true` — it is dev scaffolding, off the moment auth is enforced.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as v from "../validation";
import { signToken } from "../lib/jwt";
import { unauthorized } from "../lib/http";
import { checkLogin, findBoUserByUsername, type BoUserRow } from "../services/bo-user.service";
import type { FoCredential } from "../services/bo-user-admin.service";

const WRONG = "Wrong username or password."; // ONE sentence for unknown / wrong / inactive

/** `lookup` is injectable so the route is testable without a database. */
export function makeAuthRoutes(lookup: (username: string) => Promise<BoUserRow | undefined> = findBoUserByUsername, fo?: (foUserId: string) => Promise<FoCredential | undefined>) {
  return new Hono().post("/login", zValidator("json", v.login), async (c) => {
    const { username, password } = c.req.valid("json");

    if (process.env.SKIP_ADMIN_AUTH === "true") {
      const stubUser = process.env.ADMIN_USERNAME ?? "admin";
      const stubPass = process.env.ADMIN_PASSWORD ?? "admin";
      if (username === stubUser && password === stubPass) {
        const token = await signToken({ sub: username, role: "admin" });
        return c.json({ token, user: { username, role: "admin" as const, teacherId: null } });
      }
    }

    const user = await checkLogin(username, password, lookup, fo);
    if (!user) throw unauthorized(WRONG);
    const token = await signToken({ sub: user.username, role: user.role, teacherId: user.teacherId });
    return c.json({ token, user });
  });
}

export const authRoutes = makeAuthRoutes();
