import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { signToken } from "../lib/jwt";
import { ApiException } from "../lib/http";

// TASK-924 — /reports route tests. The STUDENT service is mocked (no database); the COURSE / OVERVIEW services are the
// real 501 stubs until TASK-926 fills them. Pins: the gate, each route's 400s, the query defaults, the role handed on.
const calls: Record<string, unknown[]> = {};
mock.module("../services/reports-students.service", () => ({
  reportStudents: mock(async (q: unknown) => {
    (calls.students ??= []).push(q);
    return { rows: [], counts: { active: 0, inactive: 0 } };
  }),
}));

const { reportsRoutes } = await import("./reports");

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  saved.JWT_SECRET = process.env.JWT_SECRET;
  saved.SKIP_ADMIN_AUTH = process.env.SKIP_ADMIN_AUTH;
  process.env.JWT_SECRET = "test-secret-abc";
  delete process.env.SKIP_ADMIN_AUTH;
});
afterAll(() => {
  for (const k of Object.keys(saved)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
});

const app = () => {
  const a = new Hono();
  a.onError((err, c) =>
    err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "INTERNAL" } }, 500),
  );
  return a.route("/reports", reportsRoutes);
};
const auth = async (role: "ceo" | "admin" | "coach" = "ceo") => ({ Authorization: `Bearer ${await signToken({ sub: "u1", role })}` });
const get = async (path: string, headers?: Record<string, string>) => app().request(path, { headers: headers ?? (await auth()) });
const body = async (r: Response) => (await r.json()) as { error?: { code: string } };

// 🔻 TASK-926: the COURSE / OVERVIEW stubs are replaced by the real services (they need a database), so "a valid query reaches the service" = it is NOT stopped by validation or the access gate.
const reachedService = (status: number): boolean => ![400, 401, 403, 404].includes(status);

const PATHS = ["/reports/students", "/reports/courses?from=2026-11-01&to=2026-11-09", "/reports/overview?month=2026-11"];

describe("gate: CEO + admin only", () => {
  for (const p of PATHS) {
    test(`${p}: no token 401 · coach 403`, async () => {
      expect((await get(p, {})).status).toBe(401);
      expect((await get(p, await auth("coach"))).status).toBe(403);
    });
  }
  test("admin and ceo pass the gate on students", async () => {
    expect((await get("/reports/students", await auth("admin"))).status).toBe(200);
    expect((await get("/reports/students", await auth("ceo"))).status).toBe(200);
  });
});

describe("GET /reports/students", () => {
  test("defaults to status=ACTIVE and passes q / subjectId through", async () => {
    const SUB = "11111111-1111-4111-8111-111111111111";
    const r = await get(`/reports/students?q=${encodeURIComponent("  ปลา  ")}&subjectId=${SUB}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ rows: [], counts: { active: 0, inactive: 0 } });
    expect(calls.students).toEqual([{ q: "ปลา", status: "ACTIVE", subjectId: SUB }]);
  });
  test("400 VALIDATION: bad status, bad subjectId, over-long q", async () => {
    for (const qs of ["status=ALL2", "subjectId=nope", `q=${"x".repeat(101)}`]) {
      const r = await get(`/reports/students?${qs}`);
      expect(r.status).toBe(400);
      expect((await body(r)).error?.code).toBe("VALIDATION");
    }
    expect(calls.students).toBeUndefined();
  });
});

describe("GET /reports/courses", () => {
  test("400 VALIDATION: missing / non-real / reversed / too-wide dates, bad branch", async () => {
    for (const qs of ["", "from=2026-11-01", "from=2026-02-30&to=2026-03-01", "from=2026-11-09&to=2026-11-01", "from=2025-01-01&to=2026-11-01", "from=2026-11-01&to=2026-11-09&branch=NOPE"]) {
      const r = await get(`/reports/courses?${qs}`);
      expect(r.status).toBe(400);
      expect((await body(r)).error?.code).toBe("VALIDATION");
    }
  });
  test("a valid query reaches the service (past validation and the gate)", async () => {
    const r = await get("/reports/courses?from=2026-11-01&to=2026-11-09&branch=BRAVO");
    expect(reachedService(r.status)).toBe(true);
  });
  test("the range limit is 366 days (edge in, edge out)", async () => {
    expect(reachedService((await get("/reports/courses?from=2025-11-09&to=2026-11-10")).status)).toBe(true); // 366 days apart: valid
    expect((await get("/reports/courses?from=2025-11-08&to=2026-11-10")).status).toBe(400); // 367
  });
});

describe("GET /reports/overview", () => {
  test("400 VALIDATION: missing month, bad month, bad branch", async () => {
    for (const qs of ["", "month=2026-13", "month=2026-1", "month=2026-11-01", "month=2026-11&branch=x"]) {
      const r = await get(`/reports/overview?${qs}`);
      expect(r.status).toBe(400);
      expect((await body(r)).error?.code).toBe("VALIDATION");
    }
  });
  test("a valid query reaches the service (past validation and the gate)", async () => {
    const r = await get("/reports/overview?month=2026-11&branch=OTHER");
    expect(reachedService(r.status)).toBe(true); // 🔻 TASK-926 (was: the 501 stub)
  });
});
