// TASK-856 / SPEC-097 §4 — requireAuth / requireRole, and what the three roles may reach. No database.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminAuth, adminOrService, requireAuth, requireRole } from "./auth";
import { signToken, verifyToken, ROLES, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";

const KEYS = ["JWT_SECRET", "SERVICE_TOKEN", "SKIP_ADMIN_AUTH"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-856";
  process.env.SERVICE_TOKEN = "svc-856";
  process.env.SKIP_ADMIN_AUTH = "false";
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function probe() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json({ error: { code: err.code } }, err.status as 400);
    return c.json({ error: { code: "INTERNAL", message: String(err) } }, 500);
  });
  app.get("/any", requireAuth, (c) => c.json({ user: c.get("user") }));
  app.get("/ceo-only", requireRole("ceo"), (c) => c.json({ ok: true }));
  app.get("/staff", requireRole("ceo", "admin"), (c) => c.json({ ok: true }));
  app.get("/admin-auth", adminAuth, (c) => c.json({ ok: true }));
  app.get("/guarded", adminOrService, (c) => c.json({ ok: true }));
  return app;
}
const as = async (role: Role | null, teacherId?: string): Promise<Record<string, string>> => {
  if (!role) return {};
  return { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role, teacherId })}` };
};
const get = async (path: string, role: Role | null, extra: Record<string, string> = {}) =>
  probe().request(path, { headers: { ...(await as(role)), ...extra } });

describe("requireRole(\"ceo\") on a probe route — the three roles + no token", () => {
  test("ceo → 200", async () => expect((await get("/ceo-only", "ceo")).status).toBe(200));
  test("admin → 403 FORBIDDEN", async () => {
    const r = await get("/ceo-only", "admin");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });
  test("coach → 403 FORBIDDEN", async () => expect((await get("/ceo-only", "coach")).status).toBe(403));
  test("no token → 401", async () => expect((await get("/ceo-only", null)).status).toBe(401));
  test("garbage token → 401", async () => expect((await get("/ceo-only", null, { Authorization: "Bearer nope" })).status).toBe(401));
});

describe("requireRole(\"ceo\",\"admin\") — where an admin may act", () => {
  test("ceo 200 · admin 200 · coach 403 · none 401", async () => {
    expect((await get("/staff", "ceo")).status).toBe(200);
    expect((await get("/staff", "admin")).status).toBe(200);
    expect((await get("/staff", "coach")).status).toBe(403);
    expect((await get("/staff", null)).status).toBe(401);
  });
});

describe("requireAuth — any signed-in role; c.var.user = {sub, role, teacherId}", () => {
  test("a coach's token carries their teacherId through", async () => {
    const res = await probe().request("/any", { headers: await as("coach", "11111111-1111-4111-8111-111111111111") });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { sub: string; role: string; teacherId: string } };
    expect(user).toMatchObject({ sub: "u-coach", role: "coach", teacherId: "11111111-1111-4111-8111-111111111111" });
  });
  test("every role passes, none does not", async () => {
    for (const r of ROLES) expect((await get("/any", r)).status).toBe(200);
    expect((await get("/any", null)).status).toBe(401);
  });
});

describe("the existing staff gates now know roles", () => {
  test("adminAuth: ceo 200 · admin 200 · coach 403 · none 401", async () => {
    expect((await get("/admin-auth", "ceo")).status).toBe(200);
    expect((await get("/admin-auth", "admin")).status).toBe(200);
    expect((await get("/admin-auth", "coach")).status).toBe(403);
    expect((await get("/admin-auth", null)).status).toBe(401);
  });
  test("adminOrService: a service token still passes; a coach JWT does not", async () => {
    expect((await get("/guarded", null, { "X-Service-Token": "svc-856" })).status).toBe(200);
    expect((await get("/guarded", "coach")).status).toBe(403);
    expect((await get("/guarded", "admin")).status).toBe(200);
  });
});

describe("tokens", () => {
  test("a token whose role is not one of the three is rejected", async () => {
    const { sign } = await import("hono/jwt");
    const bad = await sign({ sub: "x", role: "super", exp: Math.floor(Date.now() / 1000) + 600 }, "test-secret-856", "HS256");
    await expect(verifyToken(bad)).rejects.toBeDefined();
    expect((await probe().request("/any", { headers: { Authorization: `Bearer ${bad}` } })).status).toBe(401);
  });
  test("ROLES is exactly ceo / admin / coach (lower-case, as final-ui)", () => {
    expect([...ROLES]).toEqual(["ceo", "admin", "coach"]);
  });
});

describe("SKIP_ADMIN_AUTH=true is dev only", () => {
  test("no token ⇒ the dev user (ceo) reaches every gate; a valid Bearer still wins", async () => {
    process.env.SKIP_ADMIN_AUTH = "true";
    try {
      expect((await get("/ceo-only", null)).status).toBe(200);
      expect((await get("/ceo-only", "coach")).status).toBe(403); // the Bearer's role is honoured
    } finally {
      process.env.SKIP_ADMIN_AUTH = "false";
    }
    expect((await get("/ceo-only", null)).status).toBe(401); // back to enforced
  });
});
