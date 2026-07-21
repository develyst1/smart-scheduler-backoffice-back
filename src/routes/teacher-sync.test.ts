import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { teacherSyncRoutes } from "./teacher-sync";
import { ApiException } from "../lib/http";

const savedSvc = process.env.SERVICE_TOKEN;
beforeAll(() => {
  process.env.SERVICE_TOKEN = "svc-token-xyz";
});
afterAll(() => {
  if (savedSvc === undefined) delete process.env.SERVICE_TOKEN;
  else process.env.SERVICE_TOKEN = savedSvc;
});

function makeApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiException)
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "INTERNAL", message: "err" } }, 500);
  });
  return app.route("/ts", teacherSyncRoutes);
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  makeApp().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const SVC = { "X-Service-Token": "svc-token-xyz" };

describe("teacher-sync routes — serviceAuth guard (TASK-015)", () => {
  test("no service token → 401 (before the handler / DB)", async () => {
    const res = await post("/ts/onboard", { externalRef: "t1", displayName: "Mark" });
    expect(res.status).toBe(401);
  });
});

describe("teacher-sync routes — validation (TASK-015)", () => {
  test("onboard requires displayName → 400 with a valid token", async () => {
    const res = await post("/ts/onboard", { externalRef: "t1" }, SVC);
    expect(res.status).toBe(400);
  });

  test("onboard requires externalRef → 400", async () => {
    const res = await post("/ts/onboard", { displayName: "Mark" }, SVC);
    expect(res.status).toBe(400);
  });

  test("offboard requires a YYYY-MM effectiveMonth → 400", async () => {
    const res = await post("/ts/offboard", { externalRef: "t1", effectiveMonth: "2026-7-1" }, SVC);
    expect(res.status).toBe(400);
  });

  test("switch-type rejects a bad month → 400", async () => {
    const res = await post("/ts/switch-type", { externalRef: "t1", effectiveMonth: "nope" }, SVC);
    expect(res.status).toBe(400);
  });
});
