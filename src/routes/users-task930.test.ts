// TASK-930 - /users routes (admit a front-office person, list, deactivate / reactivate) and the sign-in verify-through. No database: an in-memory UsersStore + a fake front office.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { makeUserRoutes } from "./users";
import { makeAuthRoutes } from "./auth";
import { signToken } from "../lib/jwt";
import { ApiException } from "../lib/http";
import { hashPassword, type BoUserRow } from "../services/bo-user.service";
import type { AdmittedUserDTO, FoUser, UsersStore } from "../services/bo-user-admin.service";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const FO_PW = "front-office-pw-1";
const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
const saved: Record<string, string | undefined> = {};
let fo: Record<string, FoUser>;
let bo: BoUserRow[];
let tokens: Record<string, string>;
let foHash: string;

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-930";
  process.env.SKIP_ADMIN_AUTH = "false";
  foHash = await hashPassword(FO_PW);
  tokens = { ceo: await signToken({ sub: "phi", role: "ceo" }), admin: await signToken({ sub: "khwan", role: "admin" }), coach: await signToken({ sub: "ton", role: "coach", teacherId: T1 }) };
});
afterAll(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const reset = async () => {
  const f = (id: string, username: string, extra: Partial<FoUser> = {}): FoUser => ({ id, username, passwordHash: foHash, disabledAt: null, teacherId: null, ...extra });
  fo = {
    khwan: f("f0000000-0000-4000-8000-000000000001", "khwan"),
    ton: f("f0000000-0000-4000-8000-000000000002", "ton", { teacherId: T1 }),
    noteacher: f("f0000000-0000-4000-8000-000000000003", "noteacher"),
    off: f("f0000000-0000-4000-8000-000000000004", "off", { disabledAt: new Date() }),
  };
  bo = [{ id: "b0000000-0000-4000-8000-000000000009", username: "phi", passwordHash: await hashPassword("ceo-own-password"), role: "ceo", teacherId: null, active: true, foUserId: null, createdAt: new Date(), updatedAt: new Date() }];
};

const dto = (r: BoUserRow): AdmittedUserDTO => ({ id: r.id, username: r.username, role: r.role, teacherId: r.teacherId, active: r.active, admitted: r.foUserId !== null, createdAt: r.createdAt.toISOString() });
const store: UsersStore = {
  foByUsername: async (u) => fo[u],
  boByUsernameOrFoId: async (u, id) => bo.find((r) => r.username === u || r.foUserId === id),
  insert: async (row) => {
    const r: BoUserRow = { id: crypto.randomUUID(), ...row, active: true, createdAt: new Date(), updatedAt: new Date() };
    bo.push(r);
    return dto(r);
  },
  list: async () => bo.map(dto),
  get: async (id) => bo.find((r) => r.id === id),
  setActive: async (id, active) => {
    const r = bo.find((x) => x.id === id)!;
    r.active = active;
    return dto(r);
  },
};
const fakeFo = async (id: string) => Object.values(fo).find((u) => u.id === id);

function app() {
  const a = new Hono();
  a.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400) : c.json({ error: { code: "INTERNAL", message: String(err) } }, 500)));
  a.route("/users", makeUserRoutes(store));
  a.route("/auth", makeAuthRoutes(async (u) => bo.find((r) => r.username === u), fakeFo));
  return a;
}
const call = (method: string, path: string, who?: string, body?: unknown) =>
  app().request(path, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const login = (username: string, password: string) => app().request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });

const ROUTES: [string, string, unknown][] = [
  ["GET", "/users", undefined],
  ["POST", "/users", { username: "khwan", role: "admin" }],
  ["POST", "/users/b0000000-0000-4000-8000-000000000009/deactivate", undefined],
  ["POST", "/users/b0000000-0000-4000-8000-000000000009/reactivate", undefined],
];

describe("every route is CEO only", () => {
  for (const [m, p, b] of ROUTES) {
    test(`${m} ${p}: no token 401 · admin 403 · coach 403`, async () => {
      await reset();
      expect((await call(m, p, undefined, b)).status).toBe(401);
      expect((await call(m, p, "admin", b)).status).toBe(403);
      expect((await call(m, p, "coach", b)).status).toBe(403);
      expect(bo).toHaveLength(1); // nothing written by a refused call
    });
  }
});

describe("POST /users (admit)", () => {
  test("valid body passes: 201, role + fo link set, the FO hash is copied, NO hash or password in the response", async () => {
    await reset();
    const res = await call("POST", "/users", "ceo", { username: " Khwan ", role: "admin" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AdmittedUserDTO;
    expect(body).toMatchObject({ username: "khwan", role: "admin", teacherId: null, active: true, admitted: true });
    expect(JSON.stringify(body)).not.toMatch(/hash|password|argon/i);
    const row = bo.find((r) => r.username === "khwan")!;
    expect(row.foUserId).toBe(fo.khwan!.id);
    expect(row.passwordHash).toBe(foHash);
  });
  test("bad bodies are 400: no body, bad username, bad role, ceo, bad teacherId", async () => {
    await reset();
    for (const b of [undefined, "x", [], {}, { username: "k", role: "admin" }, { username: "khwan" }, { username: "khwan", role: "root" }, { username: "khwan", role: "ceo" }, { username: "ton", role: "coach", teacherId: "nope" }]) {
      const res = await call("POST", "/users", "ceo", b);
      expect(res.status).toBe(400);
    }
    expect(bo).toHaveLength(1);
  });
  test("every admit VALIDATION 400 names the failing field under error.details.field", async () => {
    await reset();
    const field = async (b: unknown) => ((await (await call("POST", "/users", "ceo", b)).json()) as { error: { code: string; details?: { field?: string } } }).error;
    expect(await field({ username: "k", role: "admin" })).toMatchObject({ code: "VALIDATION", details: { field: "username" } });
    expect(await field({ username: "khwan", role: "root" })).toMatchObject({ details: { field: "role" } });
    expect(await field({ username: "khwan" })).toMatchObject({ details: { field: "role" } });
    expect(await field({ username: "khwan", role: "ceo" })).toMatchObject({ details: { field: "role" } });
    expect(await field({ username: "ton", role: "coach", teacherId: "nope" })).toMatchObject({ details: { field: "teacherId" } });
    expect(await field({ username: "noteacher", role: "coach" })).toMatchObject({ details: { field: "teacherId" } }); // a coach with no FO teacher: the FE shows the person picker
    expect(await field({ username: "off", role: "admin" })).toMatchObject({ details: { field: "username" } });
    const nf = (await (await call("POST", "/users", "ceo", { username: "ghost", role: "admin" })).json()) as { error: { code: string } };
    expect(nf.error.code).toBe("NOT_FOUND"); // the 404 is unchanged
  });
  test("a person who is not in the front office is 404; a front-office-disabled one is 400", async () => {
    await reset();
    expect((await call("POST", "/users", "ceo", { username: "ghost", role: "admin" })).status).toBe(404);
    expect((await call("POST", "/users", "ceo", { username: "off", role: "admin" })).status).toBe(400);
  });
  test("a duplicate is 409 (by username or by the FO link)", async () => {
    await reset();
    expect((await call("POST", "/users", "ceo", { username: "khwan", role: "admin" })).status).toBe(201);
    const again = await call("POST", "/users", "ceo", { username: "khwan", role: "coach", teacherId: T2 });
    expect(again.status).toBe(409);
    expect(bo).toHaveLength(2);
  });
  test("coach: teacherId defaults from the FO row; the body overrides; none anywhere is 400", async () => {
    await reset();
    expect(((await (await call("POST", "/users", "ceo", { username: "ton", role: "coach" })).json()) as AdmittedUserDTO).teacherId).toBe(T1);
    expect((await call("POST", "/users", "ceo", { username: "noteacher", role: "coach" })).status).toBe(400);
    const ok = await call("POST", "/users", "ceo", { username: "noteacher", role: "coach", teacherId: T2 });
    expect(((await ok.json()) as AdmittedUserDTO).teacherId).toBe(T2);
  });
  test("an admin never carries a teacherId even if one is sent", async () => {
    await reset();
    expect(((await (await call("POST", "/users", "ceo", { username: "ton", role: "admin", teacherId: T2 })).json()) as AdmittedUserDTO).teacherId).toBeNull();
  });
});

describe("create → list round trip, deactivate / reactivate", () => {
  test("list shows the admitted person and never a hash; deactivate then reactivate", async () => {
    await reset();
    const made = (await (await call("POST", "/users", "ceo", { username: "khwan", role: "admin" })).json()) as AdmittedUserDTO;
    const list = await call("GET", "/users", "ceo");
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).not.toMatch(/hash|password|argon/i);
    expect((JSON.parse(text) as AdmittedUserDTO[]).map((u) => u.username).sort()).toEqual(["khwan", "phi"]);
    const off = (await (await call("POST", `/users/${made.id}/deactivate`, "ceo")).json()) as AdmittedUserDTO;
    expect(off.active).toBe(false);
    expect(bo).toHaveLength(2); // soft: never deleted
    expect(((await (await call("POST", `/users/${made.id}/reactivate`, "ceo")).json()) as AdmittedUserDTO).active).toBe(true);
  });
  test("bad id 400, unknown id 404, the CEO row is refused (400)", async () => {
    await reset();
    expect((await call("POST", "/users/not-a-uuid/deactivate", "ceo")).status).toBe(400);
    expect((await call("POST", "/users/99999999-9999-4999-8999-999999999999/deactivate", "ceo")).status).toBe(404);
    expect((await call("POST", "/users/b0000000-0000-4000-8000-000000000009/deactivate", "ceo")).status).toBe(400);
    expect(bo[0]!.active).toBe(true);
  });
});

describe("sign-in: the SAME login as the front office", () => {
  test("an admitted person signs in with the FO password; a wrong one and the old BB value fail", async () => {
    await reset();
    await call("POST", "/users", "ceo", { username: "khwan", role: "admin" });
    const ok = await login("khwan", FO_PW);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: unknown }).user).toEqual({ username: "khwan", role: "admin", teacherId: null });
    expect((await login("khwan", "wrong-password")).status).toBe(401);
  });
  test("an FO password CHANGE carries over at once (no drift); the stale copy no longer works", async () => {
    await reset();
    await call("POST", "/users", "ceo", { username: "khwan", role: "admin" });
    fo.khwan!.passwordHash = await hashPassword("changed-in-front-office");
    expect((await login("khwan", "changed-in-front-office")).status).toBe(200);
    expect((await login("khwan", FO_PW)).status).toBe(401);
  });
  test("an FO disable (or a vanished FO person) blocks sign-in; a BB deactivate blocks it too and a reactivate restores it", async () => {
    await reset();
    const made = (await (await call("POST", "/users", "ceo", { username: "khwan", role: "admin" })).json()) as AdmittedUserDTO;
    fo.khwan!.disabledAt = new Date();
    expect((await login("khwan", FO_PW)).status).toBe(401);
    fo.khwan!.disabledAt = null;
    expect((await login("khwan", FO_PW)).status).toBe(200);
    await call("POST", `/users/${made.id}/deactivate`, "ceo");
    expect((await login("khwan", FO_PW)).status).toBe(401);
    await call("POST", `/users/${made.id}/reactivate`, "ceo");
    expect((await login("khwan", FO_PW)).status).toBe(200);
    delete fo.khwan;
    expect((await login("khwan", FO_PW)).status).toBe(401);
  });
  test("the env-seeded CEO keeps its OWN password and is never FO-verified", async () => {
    await reset();
    expect((await login("phi", "ceo-own-password")).status).toBe(200);
    expect((await login("phi", FO_PW)).status).toBe(401);
  });
  test("a coach admitted from the FO signs in carrying the teacherId", async () => {
    await reset();
    await call("POST", "/users", "ceo", { username: "ton", role: "coach" });
    const body = (await (await login("ton", FO_PW)).json()) as { user: unknown };
    expect(body.user).toEqual({ username: "ton", role: "coach", teacherId: T1 });
  });
  test("there is no password route", async () => {
    await reset();
    for (const p of ["/users/b0000000-0000-4000-8000-000000000009/reset-password", "/users/b0000000-0000-4000-8000-000000000009/password"]) expect((await call("POST", p, "ceo", { password: "x" })).status).toBe(404);
  });
});
