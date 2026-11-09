// TASK-896 (shipped earlier under a TASK-890 tag; 890 is Sector's) - serviceAuth FAILS CLOSED. It used to call next() when SERVICE_TOKEN was unset, so teacher-sync, accounts debits and recurring were open to anyone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ApiException } from "../lib/http";
import { teacherSyncRoutes } from "../routes/teacher-sync";
import { PLACEHOLDER_SERVICE_TOKENS, adminOrService, configuredServiceToken, serviceAuth } from "./auth";

const KEYS = ["SERVICE_TOKEN", "SKIP_ADMIN_AUTH"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const env = (token: string | undefined, skip?: string) => {
  if (token === undefined) delete process.env.SERVICE_TOKEN;
  else process.env.SERVICE_TOKEN = token;
  if (skip === undefined) delete process.env.SKIP_ADMIN_AUTH;
  else process.env.SKIP_ADMIN_AUTH = skip;
};
const onError = (err: unknown, c: any) => (err instanceof ApiException ? c.json({ error: { code: err.code } }, err.status as 400) : c.json({ error: { code: "INTERNAL" } }, 500));
const app = new Hono().onError(onError).post("/m", serviceAuth, (c) => c.json({ ok: true }));
const hit = (headers: Record<string, string> = {}) => app.request("/m", { method: "POST", headers });

describe("serviceAuth (fail closed)", () => {
  test("enforced + SERVICE_TOKEN unset => 401 (it used to PASS)", async () => {
    env(undefined);
    expect((await hit()).status).toBe(401);
    expect((await hit({ "X-Service-Token": "anything" })).status).toBe(401);
    expect((await hit({ Authorization: "Bearer anything" })).status).toBe(401);
  });
  test("an EMPTY SERVICE_TOKEN is unset too => 401, and an empty presented token does not match it", async () => {
    env("");
    expect((await hit()).status).toBe(401);
    expect((await hit({ "X-Service-Token": "" })).status).toBe(401);
  });
  test("configured: the right token (X-Service-Token or Bearer) => 200", async () => {
    env("svc-896");
    expect((await hit({ "X-Service-Token": "svc-896" })).status).toBe(200);
    expect((await hit({ Authorization: "Bearer svc-896" })).status).toBe(200);
  });
  test("configured: wrong or missing token => 401", async () => {
    env("svc-896");
    expect((await hit({ "X-Service-Token": "nope" })).status).toBe(401);
    expect((await hit({ Authorization: "Bearer nope" })).status).toBe(401);
    expect((await hit()).status).toBe(401);
  });
  test("the dev bypass SKIP_ADMIN_AUTH=true still passes (like adminOrService), with or without a token configured", async () => {
    env(undefined, "true");
    expect((await hit()).status).toBe(200);
    env("svc-896", "true");
    expect((await hit()).status).toBe(200);
  });
  test("SKIP_ADMIN_AUTH other than the exact string 'true' is not a bypass", async () => {
    env(undefined, "1");
    expect((await hit()).status).toBe(401);
    env(undefined, "false");
    expect((await hit()).status).toBe(401);
  });
});

describe("a guarded route is closed when the token is unset (teacher-sync, before the handler / DB)", () => {
  test("POST /onboard with no SERVICE_TOKEN configured => 401", async () => {
    env(undefined);
    const app2 = new Hono().onError(onError).route("/ts", teacherSyncRoutes);
    const res = await app2.request("/ts/onboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ externalRef: "t1", displayName: "Mark" }) });
    expect(res.status).toBe(401);
  });
});

describe("🔒 TASK-896 - the placeholder token is NOT a configured token (enforced mode)", () => {
  const PLACEHOLDER = "change-me-service-token";
  test("the list is the repo's placeholder, in one place", () => {
    expect(PLACEHOLDER_SERVICE_TOKENS).toContain(PLACEHOLDER);
    expect(configuredServiceToken({ SERVICE_TOKEN: PLACEHOLDER })).toBeUndefined();
    expect(configuredServiceToken({ SERVICE_TOKEN: "" })).toBeUndefined();
    expect(configuredServiceToken({})).toBeUndefined();
    expect(configuredServiceToken({ SERVICE_TOKEN: "a-real-random-token" })).toBe("a-real-random-token");
  });
  test("enforced + SERVICE_TOKEN = the placeholder => 401, even when the caller presents that exact placeholder", async () => {
    env(PLACEHOLDER);
    expect((await hit()).status).toBe(401);
    expect((await hit({ "X-Service-Token": PLACEHOLDER })).status).toBe(401);
    expect((await hit({ Authorization: "Bearer " + PLACEHOLDER })).status).toBe(401);
  });
  test("a real token => 200 (and the placeholder, presented to it, => 401)", async () => {
    env("a-real-random-token");
    expect((await hit({ "X-Service-Token": "a-real-random-token" })).status).toBe(200);
    expect((await hit({ "X-Service-Token": PLACEHOLDER })).status).toBe(401);
  });
  test("the dev bypass is unaffected: SKIP_ADMIN_AUTH=true passes with the placeholder configured", async () => {
    env(PLACEHOLDER, "true");
    expect((await hit()).status).toBe(200);
  });
  test("adminOrService (the human-or-machine door) refuses the placeholder as a machine token too", async () => {
    env(PLACEHOLDER);
    const both = new Hono().onError(onError).get("/b", adminOrService, (c) => c.json({ ok: true }));
    expect((await both.request("/b", { headers: { "X-Service-Token": PLACEHOLDER } })).status).toBe(401);
    env("a-real-random-token");
    expect((await both.request("/b", { headers: { "X-Service-Token": "a-real-random-token" } })).status).toBe(200);
  });
});
