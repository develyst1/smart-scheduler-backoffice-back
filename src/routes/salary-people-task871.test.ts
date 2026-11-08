// TASK-871 / SPEC-101 §3–§4 — the F3 people model (multi-role, FL rates per class type, merit, vehicle) and the R1.4 period dates,
// through the service AND the HTTP routes. No database (in-memory store).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { makeSalaryRoutes } from "./salary";
import { createSalaryService } from "../services/salary.service";
import { memorySalaryStore } from "../services/salary-memory.store";
import { signToken, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";
import { roleOfDay } from "../lib/role-of-day";

const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-871";
  process.env.SKIP_ADMIN_AUTH = "false";
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const GHOST = "99999999-9999-4999-8999-999999999999";

function setup() {
  const svc = createSalaryService(memorySalaryStore(), () => new Date("2026-11-10T03:00:00Z"), { readHours: async () => [] });
  const routes = makeSalaryRoutes(svc);
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "INTERNAL", message: String(err) } }, 500);
  });
  app.route("/salary", routes);
  return { app, svc };
}
const call = async (app: Hono, method: string, path: string, role: Role | null = "ceo", body?: unknown) =>
  app.request(`/salary${path}`, {
    method,
    headers: {
      ...(role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const rejects = async (p: Promise<unknown>, status: number) => {
  try {
    await p;
  } catch (e) {
    expect((e as ApiException).status).toBe(status);
    return;
  }
  throw new Error(`expected a ${status} rejection`);
};

describe("R1.4: a period carries periodStart / periodEnd from payPeriodRange", () => {
  test("October 2026 = 2026-09-30 … 2026-10-30; the label (year/month) and the 12:00 lock are unchanged", async () => {
    const svc = createSalaryService(memorySalaryStore(), () => new Date("2026-10-10T03:00:00Z"), { readHours: async () => [] }); // a clock BEFORE this period's 12:00 lock
    const p = await svc.createPeriod(2026, 10);
    expect(p).toMatchObject({ year: 2026, month: 10, periodStart: "2026-09-30", periodEnd: "2026-10-30", status: "open", lockAt: "2026-10-31T05:00:00.000Z" });
    // the lock instant (confirm day) is one day AFTER period_end — correct per SPEC-101 §3
    const q = await svc.createPeriod(2027, 1);
    expect(q).toMatchObject({ periodStart: "2026-12-31", periodEnd: "2027-01-30" });
    const f = await svc.createPeriod(2028, 2);
    expect(f).toMatchObject({ periodStart: "2028-01-31", periodEnd: "2028-02-28" });
  });
  test("the overview and the list carry the dates too", async () => {
    const { svc } = setup();
    const p = await svc.createPeriod(2026, 11);
    expect((await svc.getPeriod(p.id)).period).toMatchObject({ periodStart: "2026-10-31", periodEnd: "2026-11-29" });
    expect((await svc.listPeriods())[0]).toMatchObject({ periodStart: "2026-10-31", periodEnd: "2026-11-29" });
  });
});

describe("the people model: roles, merit, vehicle", () => {
  test("a new profile starts as before: one role, merit off, no vehicle", async () => {
    const { svc } = setup();
    expect(await svc.setProfile(T1, { employmentType: "FT", baseSalary: 2_500_000, active: true })).toEqual({
      teacherId: T1, employmentType: "FT", roles: ["FT"], baseSalary: 2_500_000, active: true, meritEligible: false, vehicle: null,
    });
  });
  test("PT + FL: roles come back as the set; roleOfDay reads it (FL Mon–Fri, PT Sat–Sun)", async () => {
    const { svc } = setup();
    const p = await svc.setProfile(T1, { employmentType: "PT", baseSalary: null, active: true, roles: ["PT", "FL"] });
    expect(p.roles.sort()).toEqual(["FL", "PT"]);
    expect(roleOfDay(p, "2026-11-04")).toBe("FL"); // Wednesday
    expect(roleOfDay(p, "2026-11-07")).toBe("PT"); // Saturday
  });
  test("an invalid combination is 400 (FT+PT, STAFF with PT+FL, the lone role differing from employmentType)", async () => {
    const { svc } = setup();
    await rejects(svc.setProfile(T1, { employmentType: "FT", baseSalary: null, active: true, roles: ["FT", "PT"] }), 400);
    await rejects(svc.setProfile(T1, { employmentType: "STAFF", baseSalary: null, active: true, roles: ["PT", "FL"] }), 400);
    await rejects(svc.setProfile(T1, { employmentType: "FT", baseSalary: null, active: true, roles: ["PT"] }), 400);
  });
  test("omitted TASK-871 fields keep what is stored; set ones change; vehicle can be cleared with null", async () => {
    const { svc } = setup();
    await svc.setProfile(T1, { employmentType: "FT", baseSalary: 1, active: true, meritEligible: true, vehicle: "motorbike" });
    const keep = await svc.setProfile(T1, { employmentType: "FT", baseSalary: 2, active: true }); // a SPEC-100-style update
    expect(keep).toMatchObject({ baseSalary: 2, meritEligible: true, vehicle: "motorbike" });
    expect((await svc.setProfile(T1, { employmentType: "FT", baseSalary: 2, active: true, meritEligible: false, vehicle: null }))).toMatchObject({ meritEligible: false, vehicle: null });
  });
  test("the pay run takes ACTIVE FT / PT / FL profiles (TASK-878); STAFF and inactive are skipped", async () => {
    const { svc } = setup();
    await svc.setProfile(T1, { employmentType: "FT", baseSalary: 1_000_000, active: true, meritEligible: true, vehicle: "car" });
    await svc.setProfile(T2, { employmentType: "PT", baseSalary: 1_000_000, active: true, roles: ["PT", "FL"] });
    const p = await svc.createPeriod(2026, 11);
    expect(await svc.runPeriod(p.id)).toEqual({ created: 2, refreshed: 0 });
  });
});

describe("FL rates per person per class type (R1.2)", () => {
  test("set, update, read back in class-type order (integer satang per hour); a person's rates are independent", async () => {
    const { svc } = setup();
    await svc.setProfile(T1, { employmentType: "FL", baseSalary: null, active: true });
    await svc.setProfile(T2, { employmentType: "FL", baseSalary: null, active: true });
    expect(await svc.getFlRates(T1)).toEqual([]);
    await svc.setFlRate(T1, "group", 25_000);
    await svc.setFlRate(T1, "private", 40_000);
    await svc.setFlRate(T1, "eca", 30_050);
    expect(await svc.getFlRates(T1)).toEqual([
      { classType: "private", rate: 40_000 },
      { classType: "group", rate: 25_000 },
      { classType: "eca", rate: 30_050 },
    ]);
    expect(await svc.setFlRate(T1, "private", 45_000)).toEqual({ classType: "private", rate: 45_000 }); // upsert
    expect((await svc.getFlRates(T1)).find((r) => r.classType === "private")!.rate).toBe(45_000);
    expect(await svc.getFlRates(T2)).toEqual([]); // untouched
  });
  test("a rate of 0 is allowed; negative / fractional / bad class type = 400; an unknown person = 404", async () => {
    const { svc } = setup();
    await svc.setProfile(T1, { employmentType: "FL", baseSalary: null, active: true });
    expect(await svc.setFlRate(T1, "duo", 0)).toEqual({ classType: "duo", rate: 0 });
    await rejects(svc.setFlRate(T1, "duo", -1), 400);
    await rejects(svc.setFlRate(T1, "duo", 1.5), 400);
    await rejects(svc.setFlRate(T1, "yoga", 100), 400);
    await rejects(svc.setFlRate(GHOST, "duo", 100), 404);
    await rejects(svc.getFlRates(GHOST), 404);
  });
});

describe("HTTP: the FL-rate + profile routes are CEO-only", () => {
  test("PUT then GET fl-rates (ceo 200); the profile PUT carries roles / merit / vehicle", async () => {
    const { app } = setup();
    const put = await call(app, "PUT", `/profiles/${T1}`, "ceo", { employmentType: "PT", baseSalary: 1_500_000, active: true, roles: ["PT", "FL"], meritEligible: true, vehicle: "car" });
    expect(put.status).toBe(200);
    const prof = await json(put);
    expect(prof).toMatchObject({ teacherId: T1, employmentType: "PT", baseSalary: 1_500_000, meritEligible: true, vehicle: "car" });
    expect(prof.roles.sort()).toEqual(["FL", "PT"]);
    expect((await call(app, "GET", "/profiles")).status).toBe(200);

    const r1 = await call(app, "PUT", `/profiles/${T1}/fl-rates/private`, "ceo", { rate: 42_000 });
    expect(r1.status).toBe(200);
    expect(await json(r1)).toEqual({ classType: "private", rate: 42_000 });
    expect(await json(await call(app, "GET", `/profiles/${T1}/fl-rates`))).toEqual([{ classType: "private", rate: 42_000 }]);
  });
  test("the 400 / 404 cases", async () => {
    const { app } = setup();
    await call(app, "PUT", `/profiles/${T1}`, "ceo", { employmentType: "FL", baseSalary: null, active: true });
    expect((await call(app, "PUT", `/profiles/${T1}/fl-rates/private`, "ceo", { rate: -5 })).status).toBe(400);
    expect((await call(app, "PUT", `/profiles/${T1}/fl-rates/private`, "ceo", { rate: 1.5 })).status).toBe(400);
    expect((await call(app, "PUT", `/profiles/${T1}/fl-rates/yoga`, "ceo", { rate: 100 })).status).toBe(400);
    expect((await call(app, "PUT", `/profiles/${T1}`, "ceo", { employmentType: "FT", baseSalary: 1, active: true, vehicle: "bicycle" })).status).toBe(400);
    expect((await call(app, "PUT", `/profiles/${GHOST}/fl-rates/private`, "ceo", { rate: 100 })).status).toBe(404);
    expect((await call(app, "GET", `/profiles/${GHOST}/fl-rates`)).status).toBe(404);
    expect((await call(app, "GET", `/profiles/not-a-uuid/fl-rates`)).status).toBe(404);
  });
  test("ceo 200 · admin 403 · coach 403 · no token 401 on the FL-rate routes", async () => {
    const { app } = setup();
    await call(app, "PUT", `/profiles/${T1}`, "ceo", { employmentType: "FL", baseSalary: null, active: true });
    expect((await call(app, "GET", `/profiles/${T1}/fl-rates`, "ceo")).status).toBe(200);
    for (const role of ["admin", "coach"] as const) {
      const get = await call(app, "GET", `/profiles/${T1}/fl-rates`, role);
      expect(get.status).toBe(403);
      expect((await json(get)).error.code).toBe("FORBIDDEN");
      expect((await call(app, "PUT", `/profiles/${T1}/fl-rates/private`, role, { rate: 1 })).status).toBe(403);
      expect((await call(app, "PUT", `/profiles/${T1}`, role, { employmentType: "FT", baseSalary: 1, active: true, meritEligible: true })).status).toBe(403);
    }
    expect((await call(app, "GET", `/profiles/${T1}/fl-rates`, null)).status).toBe(401);
    expect((await call(app, "PUT", `/profiles/${T1}/fl-rates/private`, null, { rate: 1 })).status).toBe(401);
  });
});
