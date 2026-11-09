// TASK-880 / SPEC-102 - coach "My slip" (own only, resolved by the TOKEN) + the admin-blind "Entries". DB-less.
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
  process.env.JWT_SECRET = "test-secret-880";
  process.env.SKIP_ADMIN_AUTH = "false";
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const A = "aaaaaaaa-1111-4111-8111-111111111111"; // coach A, merit-eligible
const B = "bbbbbbbb-2222-4222-8222-222222222222"; // coach B, NOT merit-eligible
const NOBODY = "cccccccc-3333-4333-8333-333333333333"; // no profile

async function setup(now = "2026-10-10T03:00:00Z") {
  const store = memorySalaryStore();
  store.names.set(A, "เอ");
  store.names.set(B, "บี");
  const clock = { t: now };
  const svc = createSalaryService(store, () => new Date(clock.t), { readHours: async () => [] });
  await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true, meritEligible: true });
  await svc.setProfile(B, { employmentType: "FT", baseSalary: 1_800_000, active: true });
  const period = await svc.createPeriod(2026, 10);
  await svc.runPeriod(period.id);
  const app = new Hono();
  app.onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "INTERNAL", message: String(err) } }, 500)));
  app.route("/salary", makeSalaryRoutes(svc));
  return { app, svc, store, period, clock };
}
const call = async (app: Hono, method: string, path: string, who: { role: Role; teacherId?: string | null } | null, body?: unknown) =>
  app.request(`/salary${path}`, {
    method,
    headers: {
      ...(who ? { Authorization: `Bearer ${await signToken({ sub: `u-${who.role}`, role: who.role, teacherId: who.teacherId ?? null })}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;
const coachA = { role: "coach" as Role, teacherId: A };
const coachB = { role: "coach" as Role, teacherId: B };
const admin = { role: "admin" as Role };
const ceo = { role: "ceo" as Role };

describe("E1 - GET /salary/my-slip (a coach reads only their own)", () => {
  test("each coach gets THEIR slip - never the other's", async () => {
    const { app, store, svc } = await setup();
    const slipA = [...store.slips.values()].find((s) => s.teacherId === A)!;
    await svc.addLine(slipA.id, { amount: 150_000, label: "extra" }, "ceo");
    const a = await json(await call(app, "GET", "/my-slip?year=2026&month=10", coachA));
    expect(a).toMatchObject({ teacherId: A, teacherName: "เอ", baseAmount: 2_500_000, total: 2_650_000, status: "draft" });
    expect(a.period).toMatchObject({ year: 2026, month: 10, periodStart: "2026-09-30", periodEnd: "2026-10-30", status: "open" });
    expect(a.lines).toEqual([{ id: expect.any(String), kind: "other", kindLabel: "Other", classType: null, label: "extra", amountSatang: 150_000 }]);
    const b = await json(await call(app, "GET", "/my-slip?year=2026&month=10", coachB));
    expect(b).toMatchObject({ teacherId: B, teacherName: "บี", baseAmount: 1_800_000, total: 1_800_000, lines: [] });
  });
  test("an id supplied in ANY form is ignored: the token decides", async () => {
    const { app } = await setup();
    for (const q of [`&teacherId=${B}`, `&id=${B}`, `&sub=${B}`, `&teacher_id=${B}`]) {
      const r = await json(await call(app, "GET", `/my-slip?year=2026&month=10${q}`, coachA));
      expect(r.teacherId).toBe(A);
    }
    expect((await call(app, "GET", `/my-slip/${B}?year=2026&month=10`, coachA)).status).toBe(404);
  });
  test("no teacherId on the token (admin, ceo) -> 403 NO_TEACHER; no token -> 401", async () => {
    const { app } = await setup();
    for (const who of [admin, ceo]) {
      const r = await call(app, "GET", "/my-slip?year=2026&month=10", who);
      expect(r.status).toBe(403);
      expect((await json(r)).error.code).toBe("NO_TEACHER");
    }
    expect((await call(app, "GET", "/my-slip?year=2026&month=10", null)).status).toBe(401);
  });
  test("no period / no slip for the month -> 200 {slip:null}; bad query -> 400", async () => {
    const { app } = await setup();
    expect(await json(await call(app, "GET", "/my-slip?year=2026&month=11", coachA))).toEqual({ slip: null });
    const stranger = { role: "coach" as Role, teacherId: NOBODY };
    expect(await json(await call(app, "GET", "/my-slip?year=2026&month=10", stranger))).toEqual({ slip: null });
    expect((await call(app, "GET", "/my-slip?year=2026", coachA)).status).toBe(400);
    expect((await call(app, "GET", "/my-slip?year=2026&month=13", coachA)).status).toBe(400);
  });
  test("a coach still cannot reach the CEO-only reads", async () => {
    const { app, store } = await setup();
    const slipB = [...store.slips.values()].find((s) => s.teacherId === B)!;
    expect((await call(app, "GET", `/slips/${slipB.id}`, coachA)).status).toBe(403);
  });
});

describe("E2 - POST /salary/entries (admin-blind)", () => {
  const entry = (o: object = {}) => ({ teacherId: A, year: 2026, month: 10, kind: "merit", amountSatang: 300_000, label: "Q3", reason: "", ...o });

  test("admin 201 returns the created line ONLY - the blind contract", async () => {
    const { app } = await setup();
    const r = await call(app, "POST", "/entries", admin, entry());
    expect(r.status).toBe(201);
    const body = await json(r);
    expect(Object.keys(body).sort()).toEqual(["amountSatang", "kind", "kindLabel", "label", "lineId"]);
    expect(body).toMatchObject({ kind: "merit", kindLabel: "Merit", label: "Q3", amountSatang: 300_000 });
    const text = JSON.stringify(body);
    for (const leak of ["total", "base", "lines", "teacherId", "2500000", "2800000", B]) expect(text).not.toContain(leak);
  });
  test("it lands on the coach's slip (find-or-create); the coach sees it, and the slip is not duplicated", async () => {
    const { app, store } = await setup();
    await call(app, "POST", "/entries", admin, entry({ kind: "other", amountSatang: -5_000, label: "", reason: "late" }));
    await call(app, "POST", "/entries", admin, entry());
    const mine = await json(await call(app, "GET", "/my-slip?year=2026&month=10", coachA));
    expect(mine.lines.map((l: any) => [l.kind, l.label, l.amountSatang])).toEqual([["other", "late", -5_000], ["merit", "Q3", 300_000]]);
    expect([...store.slips.values()].filter((s) => s.teacherId === A).length).toBe(1);
  });
  test("find-or-create makes the slip when none exists yet (a profile added after the run)", async () => {
    const { app, svc, store } = await setup();
    const C = "dddddddd-4444-4444-8444-444444444444";
    await svc.setProfile(C, { employmentType: "FT", baseSalary: 1_000_000, active: true, meritEligible: true });
    expect([...store.slips.values()].some((s) => s.teacherId === C)).toBe(false);
    expect((await call(app, "POST", "/entries", admin, entry({ teacherId: C }))).status).toBe(201);
    expect([...store.slips.values()].find((s) => s.teacherId === C)).toMatchObject({ baseSatang: 1_000_000, status: "draft" });
  });
  test("disallowed kind -> 400 KIND_NOT_ALLOWED (the auto kinds, base, anything else)", async () => {
    const { app } = await setup();
    for (const kind of ["fl_pay", "extra_hour", "ot", "bonus", "transport", "base", "commission", "x"]) {
      const r = await call(app, "POST", "/entries", admin, entry({ kind }));
      expect([kind, r.status, (await json(r)).error.code]).toEqual([kind, 400, "KIND_NOT_ALLOWED"]);
    }
  });
  test("other needs a reason; zero / fractional / negative-merit amounts are 400", async () => {
    const { app } = await setup();
    expect((await call(app, "POST", "/entries", admin, entry({ kind: "other", reason: "  " }))).status).toBe(400);
    expect((await call(app, "POST", "/entries", admin, entry({ amountSatang: 0 }))).status).toBe(400);
    expect((await call(app, "POST", "/entries", admin, entry({ amountSatang: 1.5 }))).status).toBe(400);
    expect((await call(app, "POST", "/entries", admin, entry({ amountSatang: -100 }))).status).toBe(400);
  });
  test("merit on a non-eligible profile -> 422 NOT_MERIT_ELIGIBLE; unknown person / period -> 404", async () => {
    const { app } = await setup();
    const r = await call(app, "POST", "/entries", admin, entry({ teacherId: B }));
    expect(r.status).toBe(422);
    expect((await json(r)).error.code).toBe("NOT_MERIT_ELIGIBLE");
    expect((await call(app, "POST", "/entries", admin, entry({ teacherId: NOBODY }))).status).toBe(404);
    expect((await call(app, "POST", "/entries", admin, entry({ month: 11 }))).status).toBe(404);
    expect((await call(app, "POST", "/entries", admin, entry({ teacherId: "not-a-uuid" }))).status).toBe(404);
  });
  test("a locked period -> 409 LOCKED (explicit lock and the lazy 12:00 lock)", async () => {
    const { app, svc, period } = await setup();
    await svc.lockPeriod(period.id);
    const r = await call(app, "POST", "/entries", admin, entry());
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe("LOCKED");
    const late = await setup();
    late.clock.t = "2026-10-31T06:00:00Z"; // after lock_at: the lazy lock fires on this write
    expect((await call(late.app, "POST", "/entries", admin, entry())).status).toBe(409);
  });
  test("only the admin may use it: ceo, coach and anonymous are refused", async () => {
    const { app } = await setup();
    expect((await call(app, "POST", "/entries", ceo, entry())).status).toBe(403);
    expect((await call(app, "POST", "/entries", coachA, entry())).status).toBe(403);
    expect((await call(app, "POST", "/entries", null, entry())).status).toBe(401);
  });
  test("blindness on the read side: admin is 403 on every pay read", async () => {
    const { app, store, period } = await setup();
    const slipA = [...store.slips.values()].find((s) => s.teacherId === A)!;
    for (const path of [`/slips/${slipA.id}`, `/periods/${period.id}`, "/periods", `/periods/${period.id}/export`, "/profiles"]) {
      expect([path, (await call(app, "GET", path, admin)).status]).toEqual([path, 403]);
    }
    expect((await call(app, "GET", "/my-slip?year=2026&month=10", admin)).status).toBe(403); // no teacherId
  });
});

describe("TASK-886 - GET /salary/entries/people (the admin-safe picker)", () => {
  test("admin and ceo get names + meritEligible ONLY, ordered by name; the exact key set (no pay)", async () => {
    const { app, store, svc } = await setup();
    const Z = "dddddddd-4444-4444-8444-444444444444";
    store.names.set(Z, "ก้อย"); // sorts before the Latin names
    await svc.setProfile(Z, { employmentType: "FL", baseSalary: 9_900_000, active: true });
    for (const who of [admin, ceo]) {
      const r = await call(app, "GET", "/entries/people", who);
      expect(r.status).toBe(200);
      const body = await json(r);
      expect(body.map((p: any) => p.name)).toEqual(["ก้อย", "เอ", "บี"].sort((a, b) => (a < b ? -1 : 1)));
      for (const p of body) expect(Object.keys(p).sort()).toEqual(["meritEligible", "name", "teacherId"]);
      expect(body.find((p: any) => p.teacherId === A).meritEligible).toBe(true);
      expect(body.find((p: any) => p.teacherId === B).meritEligible).toBe(false);
      const text = JSON.stringify(body);
      for (const leak of ["base", "total", "2500000", "1800000", "9900000", "rate", "slip"]) expect(text).not.toContain(leak);
    }
  });
  test("a system teacher ('No Teacher') and an inactive profile are absent; a profile with no name is absent", async () => {
    const { app, store, svc } = await setup();
    store.systemIds.add(B);
    await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: false, meritEligible: true });
    const NONAME = "eeeeeeee-5555-4555-8555-555555555555";
    await svc.setProfile(NONAME, { employmentType: "FT", baseSalary: 1, active: true });
    expect(await json(await call(app, "GET", "/entries/people", admin))).toEqual([]);
  });
  test("coach 403, no token 401", async () => {
    const { app } = await setup();
    expect((await call(app, "GET", "/entries/people", coachA)).status).toBe(403);
    expect((await call(app, "GET", "/entries/people", null)).status).toBe(401);
  });
});
