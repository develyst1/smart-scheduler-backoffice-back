import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { boRoutes } from "./bo";
import { signToken } from "../lib/jwt";
import { ApiException } from "../lib/http";

const saved: Record<string, string | undefined> = {};
const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-abc";
  process.env.SKIP_ADMIN_AUTH = "false"; // enforce the admin JWT on writes
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
    if (err instanceof ApiException)
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "INTERNAL", message: "err" } }, 500);
  });
  return a.route("/bo", boRoutes);
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("bo API — admin-JWT on writes (TASK-022)", () => {
  test("POST /bo/items with no token → 401 (before the DB)", async () => {
    const res = await post("/bo/items", { name: "น้ำ", direction: "INCOME" });
    expect(res.status).toBe(401);
  });

  test("POST /bo/items with a valid admin token but missing direction → 400 (validation)", async () => {
    const token = await signToken({ sub: "admin", role: "admin" });
    const res = await post("/bo/items", { name: "น้ำ" }, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
  });

  test("POST movement rejects qty:0 shape? — non-int qty → 400", async () => {
    const token = await signToken({ sub: "admin", role: "admin" });
    const res = await post(
      "/bo/items/00000000-0000-0000-0000-000000000000/movements",
      { qty: 1.5 },
      { Authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(400);
  });
});

// ── TASK-068 — 🔐 the reads are guarded too, not just the writes ────────────────────────────────────
// The P&L was readable with no token at all: REQ-014's "finance is executive-only because it lives on the
// backoffice" was true of the UI and false of the API. Asserting per route, because "I added the middleware"
// and "the middleware actually runs on this route" are different claims.
const ID = "00000000-0000-0000-0000-000000000000";
const GUARDED_READS = [
  "/bo/reports/pl", // the route this task exists for
  "/bo/reports/revenue-by-activity?month=2026-07",
  "/bo/reports/customer-spend?month=2026-07",
  `/bo/items/${ID}/movements`, // money history
  "/bo/items", // prices + freelance ceilings (a teacher's pay rate)
  `/bo/items/${ID}`,
  "/bo/tag-groups",
];

describe("bo API — reads require the admin JWT (TASK-068)", () => {
  test.each(GUARDED_READS)("GET %s with no token → 401", async (path) => {
    expect((await app().request(path)).status).toBe(401);
  });

  test.each(GUARDED_READS)("GET %s with a malformed token → 401", async (path) => {
    const res = await app().request(path, { headers: { Authorization: "Bearer not-a-jwt" } });
    expect(res.status).toBe(401);
  });

  test("🔑 a VALID token gets past the guard — proves it isn't just rejecting everything", async () => {
    // Bad `from` reaches the validator only after adminAuth has passed ⇒ 400, not 401.
    const token = await signToken({ sub: "admin", role: "admin" });
    const res = await app().request("/bo/reports/pl?from=not-a-date", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  test("🔑 every GET in the router is guarded — a new unguarded read fails this", async () => {
    // Walks Hono's own route table rather than a hand-kept list, so adding an open GET breaks the build
    // instead of quietly re-opening the surface this task closed.
    const gets = app()
      .routes.filter((r) => r.method === "GET")
      .map((r) => r.path);
    const guarded = new Set(
      app()
        .routes.filter((r) => r.handler.name === "adminAuth")
        .map((r) => r.path),
    );
    expect(gets.filter((p) => !guarded.has(p))).toEqual([]);
  });
});
