// TASK-856 / SPEC-097 §3 — POST /auth/login against bo.users, and the login → token → /me round trip. No database
// (the user lookup is injected).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { makeAuthRoutes } from "./auth";
import { requireAuth } from "../middleware/auth";
import { hashPassword, type BoUserRow } from "../services/bo-user.service";
import { ApiException } from "../lib/http";

const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH", "ADMIN_USERNAME", "ADMIN_PASSWORD"];
const saved: Record<string, string | undefined> = {};
const TEACHER = "22222222-2222-4222-8222-222222222222";
let rows: Record<string, BoUserRow>;

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-856";
  process.env.SKIP_ADMIN_AUTH = "false";
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "admin";
  const mk = async (username: string, role: BoUserRow["role"], password: string, extra: Partial<BoUserRow> = {}): Promise<BoUserRow> => ({
    id: crypto.randomUUID(),
    username,
    passwordHash: await hashPassword(password),
    role,
    teacherId: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });
  rows = {
    phi: await mk("phi", "ceo", "ceo-password-1"),
    khwan: await mk("khwan", "admin", "admin-password-1"),
    ton: await mk("ton", "coach", "coach-password-1", { teacherId: TEACHER }),
    gone: await mk("gone", "admin", "gone-password-1", { active: false }),
  };
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function app() {
  const a = new Hono();
  a.onError((err, c) => {
    if (err instanceof ApiException) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "INTERNAL", message: String(err) } }, 500);
  });
  a.route("/auth", makeAuthRoutes(async (u) => rows[u]));
  a.get("/me", requireAuth, (c) => {
    const u = c.get("user");
    return c.json({ user: { username: u.sub, role: u.role, teacherId: u.teacherId ?? null } });
  });
  return a;
}
const login = (username: string, password: string) =>
  app().request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });

describe("POST /auth/login → { token, user: { username, role, teacherId } }", () => {
  test("ceo", async () => {
    const res = await login("phi", "ceo-password-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: unknown };
    expect(typeof body.token).toBe("string");
    expect(body.user).toEqual({ username: "phi", role: "ceo", teacherId: null });
  });
  test("coach carries teacherId", async () => {
    const body = (await (await login("ton", "coach-password-1")).json()) as { user: unknown };
    expect(body.user).toEqual({ username: "ton", role: "coach", teacherId: TEACHER });
  });
  test("the response never carries the hash", async () => {
    const text = await (await login("phi", "ceo-password-1")).text();
    expect(text).not.toContain("argon2");
    expect(text).not.toContain("passwordHash");
  });
  test("wrong password · unknown user · inactive user → 401, the SAME sentence", async () => {
    const msgs: string[] = [];
    for (const [u, p] of [["phi", "nope-nope-1"], ["nobody", "whatever-1"], ["gone", "gone-password-1"]] as const) {
      const res = await login(u, p);
      expect(res.status).toBe(401);
      msgs.push(((await res.json()) as { error: { message: string } }).error.message);
    }
    expect(new Set(msgs).size).toBe(1);
  });
  test("a body without a password → 400 (validator)", async () => {
    const res = await app().request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "phi" }) });
    expect(res.status).toBe(400);
  });
});

describe("login → token → /me round trip", () => {
  test("each role comes back as itself", async () => {
    for (const [u, p, role] of [["phi", "ceo-password-1", "ceo"], ["khwan", "admin-password-1", "admin"], ["ton", "coach-password-1", "coach"]] as const) {
      const { token } = (await (await login(u, p)).json()) as { token: string };
      const me = await app().request("/me", { headers: { Authorization: `Bearer ${token}` } });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { user: { username: string; role: string } }).user).toMatchObject({ username: u, role });
    }
  });
  test("no token → /me is 401", async () => {
    expect((await app().request("/me")).status).toBe(401);
  });
});

describe("the single-admin stub lives ONLY under SKIP_ADMIN_AUTH", () => {
  test("enforced (SKIP=false): admin/admin → 401", async () => {
    expect((await login("admin", "admin")).status).toBe(401);
  });
  test("dev (SKIP=true): admin/admin → 200 as before, role admin", async () => {
    process.env.SKIP_ADMIN_AUTH = "true";
    try {
      const res = await login("admin", "admin");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { user: unknown }).user).toEqual({ username: "admin", role: "admin", teacherId: null });
    } finally {
      process.env.SKIP_ADMIN_AUTH = "false";
    }
  });
});
