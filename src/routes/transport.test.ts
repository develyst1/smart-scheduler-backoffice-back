import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { makeSalaryRoutes } from "./salary";
import { makeTransportRoutes } from "./transport";
import { createSalaryService } from "../services/salary.service";
import { memorySalaryStore } from "../services/salary-memory.store";
import { createTransportService, memoryTransportStore, memoryTransportLineStore } from "../services/transport.service";
import { signToken, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";

// TASK-868 — the /salary/transport HTTP contract: ceo OR admin on every route (a coach and no token refused), an ADMIN's trip
// carries no amount and no vehicle, malformed ids are 404, the lock is 409. No database.

const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-868";
  process.env.SKIP_ADMIN_AUTH = "false";
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const T1 = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const salaryStore = memorySalaryStore();
  const salary = createSalaryService(salaryStore, () => new Date("2026-08-20T03:00:00Z"), { readHours: async () => [] });
  await salary.setProfile(T1, { employmentType: "FT", baseSalary: 2_500_000, active: true, vehicle: "car" });
  const oct = await salary.createPeriod(2026, 10);
  await salary.runPeriod(oct.id);
  const svc = createTransportService({ store: memoryTransportStore(), lines: memoryTransportLineStore(), salary, profiles: salaryStore });
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "INTERNAL", message: String(err) } }, 500);
  });
  app.route("/transport", makeTransportRoutes(svc));
  return { app, svc, salary, oct, routes: makeTransportRoutes(svc) };
}
const tok = async (role: Role) => ({ Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` });
const call = async (app: Hono, method: string, path: string, role: Role | null = "ceo", body?: unknown) =>
  app.request(`/transport${path}`, {
    method,
    headers: { ...(role ? await tok(role) : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const newSchool = async (app: Hono, role: Role = "admin") => (await json(await call(app, "POST", "/schools", role, { name: "STA", distanceKm: 12 }))) as { id: string };
const tripBody = (schoolId: string, over: Record<string, unknown> = {}) => ({ teacherId: T1, date: "2026-10-14", schoolId, roundTrip: true, ...over });

describe("who may call it", () => {
  test("🔑 EVERY route is behind requireRole — a new unguarded route fails this", async () => {
    const { routes } = await setup();
    const byRoute = new Map<string, string[]>();
    for (const r of routes.routes) {
      if (r.method === "ALL") continue;
      const k = `${r.method} ${r.path}`;
      byRoute.set(k, [...(byRoute.get(k) ?? []), r.handler.name]);
    }
    expect([...byRoute.keys()].sort()).toEqual(["DELETE /trips/:id", "GET /schools", "GET /trips", "POST /schools", "POST /trips", "PUT /schools/:id", "PUT /trips/:id"]);
    for (const [route, names] of byRoute) expect([route, names.includes("requireRole")]).toEqual([route, true]);
  });
  test("a probe route: ceo 200 · admin 200 · coach 403 · no token 401", async () => {
    const { app } = await setup();
    expect((await call(app, "GET", "/schools", "ceo")).status).toBe(200);
    expect((await call(app, "GET", "/schools", "admin")).status).toBe(200);
    const coach = await call(app, "GET", "/schools", "coach");
    expect(coach.status).toBe(403);
    expect((await json(coach)).error.code).toBe("FORBIDDEN");
    expect((await call(app, "GET", "/schools", null)).status).toBe(401);
  });
  test("a coach and an anonymous caller are refused on every WRITE too", async () => {
    const { app } = await setup();
    const s = await newSchool(app);
    for (const role of ["coach", null] as const) {
      const want = role ? 403 : 401;
      expect((await call(app, "POST", "/schools", role, { name: "Z", distanceKm: 1 })).status).toBe(want);
      expect((await call(app, "PUT", `/schools/${s.id}`, role, { distanceKm: 2 })).status).toBe(want);
      expect((await call(app, "POST", "/trips", role, tripBody(s.id))).status).toBe(want);
      expect((await call(app, "DELETE", `/trips/${s.id}`, role)).status).toBe(want);
    }
  });
  test("the apply-transport route and the mount are on Jason's salary router, and apply stays CEO-only (an admin is 403)", async () => {
    const salaryStore = memorySalaryStore();
    const salary = createSalaryService(salaryStore, () => new Date("2026-08-20T03:00:00Z"), { readHours: async () => [] });
    const routes = makeSalaryRoutes(salary);
    const table = routes.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    expect(table).toContain("POST /periods/:id/apply-transport");
    expect(table).toContain("GET /transport/schools");
    const app = new Hono();
    app.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code } }, err.status as 400) : c.json({ error: "x" }, 500)));
    app.route("/salary", routes);
    const id = (await salary.createPeriod(2026, 10)).id;
    const post = async (role: Role | null) => app.request(`/salary/periods/${id}/apply-transport`, { method: "POST", headers: role ? await tok(role) : {} });
    expect((await post("admin")).status).toBe(403);
    expect((await post("coach")).status).toBe(403);
    expect((await post(null)).status).toBe(401);
    expect((await post("ceo")).status).not.toBe(403);
    // …while the transport sub-router mounted in the same app lets an admin PAST THE GATE (its handler then reaches the real,
    // here unreachable, database — a 500 from that is "past the gate"; a coach is still stopped at it)
    const adminStatus = (await app.request("/salary/transport/schools", { headers: await tok("admin") })).status;
    expect([401, 403]).not.toContain(adminStatus);
    expect((await app.request("/salary/transport/schools", { headers: await tok("coach") })).status).toBe(403);
  });
});

describe("schools over HTTP", () => {
  test("POST 201 → the school; duplicate 409 SCHOOL_EXISTS; bad body 400 VALIDATION", async () => {
    const { app } = await setup();
    const r = await call(app, "POST", "/schools", "admin", { name: "NIS", distanceKm: 18 });
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ name: "NIS", distanceKm: 18, active: true });
    const dup = await call(app, "POST", "/schools", "ceo", { name: "nis", distanceKm: 5 });
    expect([dup.status, (await json(dup)).error.code]).toEqual([409, "SCHOOL_EXISTS"]);
    for (const body of [{ name: "", distanceKm: 5 }, { name: "X", distanceKm: 0 }, { name: "X", distanceKm: -1 }, { name: "X", distanceKm: "5" }, { name: "X" }, { name: "X", distanceKm: 1.234 }]) {
      const bad = await call(app, "POST", "/schools", "admin", body);
      expect([bad.status, (await json(bad)).error.code]).toEqual([400, "VALIDATION"]);
    }
    // the body schema itself refuses a non-positive distance (its message names the field), before the service is reached
    const zero = await json(await call(app, "POST", "/schools", "admin", { name: "X", distanceKm: 0 }));
    expect(zero.error.message).toStartWith("distanceKm:");
  });
  test("PUT edits the distance; an empty patch is 400; unknown id 404; a malformed id 404", async () => {
    const { app } = await setup();
    const s = await newSchool(app);
    expect(await json(await call(app, "PUT", `/schools/${s.id}`, "admin", { distanceKm: 14.5 }))).toMatchObject({ distanceKm: 14.5 });
    expect((await call(app, "PUT", `/schools/${s.id}`, "admin", {})).status).toBe(400);
    expect((await call(app, "PUT", "/schools/00000000-0000-4000-8000-0000000000ff", "admin", { distanceKm: 1 })).status).toBe(404);
    expect((await call(app, "PUT", "/schools/not-a-uuid", "admin", { distanceKm: 1 })).status).toBe(404);
  });
  test("the school list carries no pay: only id, name, distanceKm, active", async () => {
    const { app } = await setup();
    await newSchool(app);
    const [s] = await json(await call(app, "GET", "/schools", "admin"));
    expect(Object.keys(s).sort()).toEqual(["active", "distanceKm", "id", "name"]);
  });
});

describe("trips over HTTP — 🔑 an admin sees no amount", () => {
  test("an ADMIN creates a trip: 201, the response has NO amountSatang and NO vehicle", async () => {
    const { app } = await setup();
    const s = await newSchool(app);
    const r = await call(app, "POST", "/trips", "admin", tripBody(s.id));
    expect(r.status).toBe(201);
    const body = await json(r);
    expect(Object.keys(body).sort()).toEqual(["date", "id", "km", "note", "roundTrip", "schoolId", "schoolName", "teacherId"]);
    expect(JSON.stringify(body)).not.toMatch(/amount|vehicle|car/i);
    expect(body).toMatchObject({ km: 24, schoolName: "STA", roundTrip: true });
  });
  test("an admin's LIST and EDIT are clean too; the CEO's same list DOES carry the amount and vehicle", async () => {
    const { app, oct } = await setup();
    const s = await newSchool(app);
    const created = await json(await call(app, "POST", "/trips", "admin", tripBody(s.id)));
    const adminList = await json(await call(app, "GET", `/trips?periodId=${oct.id}`, "admin"));
    const adminEdit = await json(await call(app, "PUT", `/trips/${created.id}`, "admin", { km: 40 }));
    expect(JSON.stringify([adminList, adminEdit])).not.toMatch(/amount|vehicle/i);
    const ceoList = await json(await call(app, "GET", `/trips?periodId=${oct.id}`, "ceo"));
    expect(ceoList[0]).toMatchObject({ vehicle: "car", amountSatang: 24_000, km: 40 });
  });
  test("the CEO creating a trip gets the amount back (72 ฿ for 12 km one way by car)", async () => {
    const { app } = await setup();
    const s = await newSchool(app);
    expect(await json(await call(app, "POST", "/trips", "ceo", tripBody(s.id, { roundTrip: false })))).toMatchObject({ amountSatang: 7_200, vehicle: "car" });
  });
  test("an admin cannot reach the pay through the request either: extra keys in the body (vehicle, amount) are ignored, not stored", async () => {
    const { app, svc, oct } = await setup();
    const s = await newSchool(app);
    const r = await call(app, "POST", "/trips", "admin", tripBody(s.id, { vehicle: "motorbike", amountSatang: 1, amount: 1 }));
    expect(r.status).toBe(201);
    expect(((await svc.listTrips({ periodId: oct.id }, "ceo")) as { vehicle: string; amountSatang: number }[])[0]).toMatchObject({ vehicle: "car", amountSatang: 14_400 }); // 24 km by car = 144 ฿, whatever the body said
  });
  test.each([
    ["no teacherId", { teacherId: undefined }],
    ["a non-uuid teacherId", { teacherId: "abc" }],
    ["a bad date shape", { date: "14/10/2026" }],
    ["roundTrip as a string", { roundTrip: "yes" }],
    ["km 0", { km: 0 }],
    ["km negative", { km: -5 }],
    ["km not a number", { km: "far" }],
    ["no roundTrip", { roundTrip: undefined }],
  ])("400 VALIDATION — %s", async (_n, over) => {
    const { app } = await setup();
    const s = await newSchool(app);
    const r = await call(app, "POST", "/trips", "admin", tripBody(s.id, over));
    expect([r.status, (await json(r)).error.code]).toEqual([400, "VALIDATION"]);
  });
  test("a date that passes the shape but is not on the calendar is 400", async () => {
    const { app } = await setup();
    const s = await newSchool(app);
    expect((await call(app, "POST", "/trips", "admin", tripBody(s.id, { date: "2026-02-30" }))).status).toBe(400);
  });
  test("GET /trips needs a periodId (uuid): none or malformed is 400; an unknown period is 404; the teacher filter works", async () => {
    const { app, oct } = await setup();
    const s = await newSchool(app);
    await call(app, "POST", "/trips", "admin", tripBody(s.id));
    expect((await call(app, "GET", "/trips", "admin")).status).toBe(400);
    expect((await call(app, "GET", "/trips?periodId=nope", "admin")).status).toBe(400);
    expect((await call(app, "GET", "/trips?periodId=00000000-0000-4000-8000-0000000000aa", "admin")).status).toBe(404);
    expect((await json(await call(app, "GET", `/trips?periodId=${oct.id}&teacherId=${T1}`, "admin"))).length).toBe(1);
    expect((await json(await call(app, "GET", `/trips?periodId=${oct.id}&teacherId=22222222-2222-4222-8222-222222222222`, "admin"))).length).toBe(0);
  });
  test("PUT: empty patch 400; unknown 404; malformed id 404. DELETE: 204 with no body, then 404", async () => {
    const { app } = await setup();
    const s = await newSchool(app);
    const t = await json(await call(app, "POST", "/trips", "admin", tripBody(s.id)));
    expect((await call(app, "PUT", `/trips/${t.id}`, "admin", {})).status).toBe(400);
    expect((await call(app, "PUT", "/trips/00000000-0000-4000-8000-0000000000dd", "admin", { note: "x" })).status).toBe(404);
    expect((await call(app, "PUT", "/trips/zzz", "admin", { note: "x" })).status).toBe(404);
    const del = await call(app, "DELETE", `/trips/${t.id}`, "admin");
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect((await call(app, "DELETE", `/trips/${t.id}`, "admin")).status).toBe(404);
    expect((await call(app, "DELETE", "/trips/zzz", "admin")).status).toBe(404);
  });
  test("🔑 a trip in a locked period: create / edit / delete are 409 LOCKED for an admin and for the CEO", async () => {
    const { app, salary, oct } = await setup();
    const s = await newSchool(app);
    const t = await json(await call(app, "POST", "/trips", "admin", tripBody(s.id)));
    await salary.lockPeriod(oct.id);
    for (const role of ["admin", "ceo"] as const) {
      const c = await call(app, "POST", "/trips", role, tripBody(s.id));
      expect([c.status, (await json(c)).error.code]).toEqual([409, "LOCKED"]);
      expect((await call(app, "PUT", `/trips/${t.id}`, role, { note: "x" })).status).toBe(409);
      expect((await call(app, "DELETE", `/trips/${t.id}`, role)).status).toBe(409);
    }
  });
});
