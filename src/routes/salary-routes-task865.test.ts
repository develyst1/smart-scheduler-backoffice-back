// TASK-865 / SPEC-100 §5 — the /salary HTTP contract: CEO-only on EVERY route, the shapes, the 400 / 404 / 409s, the CSV.
// No database (the service runs on the in-memory store).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { makeSalaryRoutes } from "./salary";
import { createSalaryService } from "../services/salary.service";
import { memorySalaryStore } from "../services/salary-memory.store";
import { signToken, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";

const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-865";
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

async function setup() {
  const store = memorySalaryStore();
  store.names.set(T1, "ต้น");
  store.names.set(T2, "พลอย");
  const svc = createSalaryService(store, () => new Date("2026-11-10T03:00:00Z"), { readHours: async () => [] });
  await svc.setProfile(T1, { employmentType: "FT", baseSalary: 2_500_000, active: true });
  await svc.setProfile(T2, { employmentType: "FT", baseSalary: 1_800_050, active: true });
  const routes = makeSalaryRoutes(svc);
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "INTERNAL", message: String(err) } }, 500);
  });
  app.route("/salary", routes);
  return { app, routes };
}
const tok = async (role: Role) => ({ Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` });
const call = async (app: Hono, method: string, path: string, role: Role | null = "ceo", body?: unknown) =>
  app.request(`/salary${path}`, {
    method,
    headers: { ...(role ? await tok(role) : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;

describe("requireRole(\"ceo\") on every /salary route", () => {
  test("a probe route: ceo 200 · admin 403 · coach 403 · no token 401", async () => {
    const { app } = await setup();
    expect((await call(app, "GET", "/periods", "ceo")).status).toBe(200);
    const admin = await call(app, "GET", "/periods", "admin");
    expect(admin.status).toBe(403);
    expect((await json(admin)).error.code).toBe("FORBIDDEN");
    expect((await call(app, "GET", "/periods", "coach")).status).toBe(403);
    expect((await call(app, "GET", "/periods", null)).status).toBe(401);
  });

  test("🔑 EVERY route in the router is behind requireRole — a new unguarded route fails this", async () => {
    const { routes } = await setup();
    const byRoute = new Map<string, string[]>();
    for (const r of routes.routes) {
      if (r.method === "ALL") continue;
      const k = `${r.method} ${r.path}`;
      byRoute.set(k, [...(byRoute.get(k) ?? []), r.handler.name]);
    }
    expect(byRoute.size).toBe(16); // SPEC-100's 11 routes + TASK-871's 2 FL-rate routes + TASK-878's OT and Merit + 🔻 TASK-867's apply-bonus
    for (const [route, names] of byRoute) expect([route, names.includes("requireRole")]).toEqual([route, true]);
  });

  test("admin and coach are refused on the write routes too", async () => {
    const { app } = await setup();
    const p = await json(await call(app, "POST", "/periods", "ceo", { year: 2026, month: 11 }));
    for (const role of ["admin", "coach"] as const) {
      expect((await call(app, "POST", "/periods", role, { year: 2026, month: 12 })).status).toBe(403);
      expect((await call(app, "POST", `/periods/${p.id}/run`, role)).status).toBe(403);
      expect((await call(app, "POST", `/periods/${p.id}/lock`, role)).status).toBe(403);
      expect((await call(app, "GET", `/periods/${p.id}/export`, role)).status).toBe(403);
      expect((await call(app, "PUT", `/profiles/${T1}`, role, { employmentType: "FT", baseSalary: 1, active: true })).status).toBe(403);
    }
  });
});

describe("the HTTP round trip (the shapes of SPEC-100 §5)", () => {
  test("create → run → overview → slip → lines → lock → 409 → export", async () => {
    const { app } = await setup();

    const created = await call(app, "POST", "/periods", "ceo", { year: 2026, month: 11 });
    expect(created.status).toBe(201);
    const period = await json(created);
    expect(period).toMatchObject({ year: 2026, month: 11, status: "open", lockAt: "2026-11-30T05:00:00.000Z" });
    expect((await call(app, "POST", "/periods", "ceo", { year: 2026, month: 11 })).status).toBe(409); // duplicate

    expect(await json(await call(app, "POST", `/periods/${period.id}/run`))).toEqual({ created: 2, refreshed: 0 });

    const overview = await json(await call(app, "GET", `/periods/${period.id}`));
    expect(overview.period.id).toBe(period.id);
    expect(overview.slips.length).toBe(2);
    expect(Object.keys(overview.slips[0]).sort()).toEqual(["baseAmount", "id", "status", "teacherId", "teacherName", "total"]);
    expect(overview.slips.find((s: any) => s.teacherId === T1).teacherName).toBe("ต้น");
    const slipId = overview.slips.find((s: any) => s.teacherId === T1).id;

    // empty reason → 400; then two lines, one negative
    expect((await call(app, "POST", `/slips/${slipId}/lines`, "ceo", { amount: 100, label: "" })).status).toBe(400);
    const l1Res = await call(app, "POST", `/slips/${slipId}/lines`, "ceo", { amount: 150_000, label: "ค่าสอนพิเศษ" });
    expect(l1Res.status).toBe(201);
    const l1 = await json(l1Res);
    const l2 = await json(await call(app, "POST", `/slips/${slipId}/lines`, "ceo", { amount: -30_050, label: "หักมาสาย" }));

    const slip = await json(await call(app, "GET", `/slips/${slipId}`));
    expect(Object.keys(slip).sort()).toEqual(["baseAmount", "id", "lines", "period", "status", "teacherId", "teacherName", "total"]);
    expect(slip.teacherName).toBe("ต้น");
    expect(slip.total).toBe(2_500_000 + 150_000 - 30_050);
    expect(slip.lines.map((l: any) => l.amount)).toEqual([150_000, -30_050]);
    expect(Object.keys(slip.lines[0]).sort()).toEqual(["amount", "id", "kind", "kindLabel", "label", "source"]);

    expect((await call(app, "DELETE", `/slips/${slipId}/lines/${l2.id}`)).status).toBe(204);
    expect((await json(await call(app, "GET", `/slips/${slipId}`))).total).toBe(2_650_000);

    const lockedRes = await call(app, "POST", `/periods/${period.id}/lock`);
    expect(lockedRes.status).toBe(200);
    expect((await json(lockedRes)).status).toBe("locked");

    // LOCKED → 409 on every write
    const w = await call(app, "POST", `/slips/${slipId}/lines`, "ceo", { amount: 1, label: "สาย" });
    expect(w.status).toBe(409);
    expect((await json(w)).error.code).toBe("LOCKED");
    expect((await call(app, "DELETE", `/slips/${slipId}/lines/${l1.id}`)).status).toBe(409);
    expect((await call(app, "POST", `/periods/${period.id}/run`)).status).toBe(409);

    // export is a CSV and still works when locked
    const exp = await call(app, "GET", `/periods/${period.id}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-type")).toContain("text/csv");
    expect(exp.headers.get("content-disposition")).toContain("salary-2026-11.csv");
    const csv = (await exp.text()).trim().split("\r\n");
    expect(csv[0]).toBe("teacher_id,teacher_name,base_salary,total,status");
    expect(csv).toContain(`${T1},ต้น,25000.00,26500.00,locked`);
    expect(csv).toContain(`${T2},พลอย,18000.50,18000.50,locked`);
  });

  test("profiles: GET lists, PUT sets the base (integer satang)", async () => {
    const { app } = await setup();
    const list = await json(await call(app, "GET", "/profiles"));
    expect(list.length).toBe(2);
    const put = await call(app, "PUT", `/profiles/${T1}`, "ceo", { employmentType: "FT", baseSalary: 3_000_000, active: true });
    expect(put.status).toBe(200);
    expect(await json(put)).toEqual({ teacherId: T1, employmentType: "FT", roles: ["FT"], baseSalary: 3_000_000, active: true, meritEligible: false, vehicle: null });
    expect((await call(app, "PUT", `/profiles/${T1}`, "ceo", { employmentType: "FT", baseSalary: 1.5, active: true })).status).toBe(400);
    expect((await call(app, "PUT", `/profiles/${T1}`, "ceo", { employmentType: "WAT", baseSalary: 1, active: true })).status).toBe(400);
  });

  test("a malformed id is 404, never a database error", async () => {
    const { app } = await setup();
    expect((await call(app, "GET", "/periods/not-a-uuid")).status).toBe(404);
    expect((await call(app, "GET", "/slips/123")).status).toBe(404);
    expect((await call(app, "POST", "/periods/x/run")).status).toBe(404);
  });
});
