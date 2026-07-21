import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminAuth, adminOrService } from "./auth";
import { authRoutes } from "../routes/auth";
import { signToken } from "../lib/jwt";
import { ApiException } from "../lib/http";

const saved: Record<string, string | undefined> = {};
const KEYS = ["JWT_SECRET", "SERVICE_TOKEN", "SKIP_ADMIN_AUTH", "ADMIN_USERNAME", "ADMIN_PASSWORD"];

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-abc";
  process.env.SERVICE_TOKEN = "svc-token-xyz";
  process.env.SKIP_ADMIN_AUTH = "false"; // enforce auth in these tests
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "admin";
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makeApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiException)
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "INTERNAL", message: "err" } }, 500);
  });
  app.route("/auth", authRoutes);
  app.post("/guarded", adminOrService, (c) => c.json({ ok: true }));
  app.post("/admin-only", adminAuth, (c) => c.json({ ok: true }));
  return app;
}

const post = (app: Hono, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("POST /auth/login (TASK-013)", () => {
  test("correct env creds → 200 with a token + user", async () => {
    const res = await post(makeApp(), "/auth/login", { username: "admin", password: "admin" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { username: string; role: string } };
    expect(typeof body.token).toBe("string");
    expect(body.user).toEqual({ username: "admin", role: "admin" });
  });

  test("wrong password → 401", async () => {
    const res = await post(makeApp(), "/auth/login", { username: "admin", password: "nope" });
    expect(res.status).toBe(401);
  });
});

describe("adminOrService (TASK-013 — scheduling's service-token path must stay working)", () => {
  test("valid X-Service-Token → passes", async () => {
    const res = await post(makeApp(), "/guarded", {}, { "X-Service-Token": "svc-token-xyz" });
    expect(res.status).toBe(200);
  });

  test("no credentials → 401", async () => {
    const res = await post(makeApp(), "/guarded", {});
    expect(res.status).toBe(401);
  });

  test("valid admin Bearer → passes", async () => {
    const token = await signToken({ sub: "admin", role: "admin" });
    const res = await post(makeApp(), "/guarded", {}, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
  });
});

describe("adminAuth (TASK-013)", () => {
  test("no token → 401", async () => {
    const res = await post(makeApp(), "/admin-only", {});
    expect(res.status).toBe(401);
  });

  test("invalid Bearer → 401", async () => {
    const res = await post(makeApp(), "/admin-only", {}, { Authorization: "Bearer garbage.token" });
    expect(res.status).toBe(401);
  });

  test("valid login token → passes", async () => {
    const token = await signToken({ sub: "admin", role: "admin" });
    const res = await post(makeApp(), "/admin-only", {}, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
  });
});
