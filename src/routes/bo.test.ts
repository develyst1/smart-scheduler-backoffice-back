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
