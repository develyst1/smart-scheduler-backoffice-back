import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { PgDialect } from "drizzle-orm/pg-core";
import { signToken } from "../lib/jwt";
import { ApiException, badRequest, conflict } from "../lib/http";
import { boMovement } from "../db/schema";
import { boPayment, boRevenueLine } from "../db/schema-revenue";

// TASK-858 — route tests with the SERVICE mocked (as bo.test.ts keeps the DB out): the shape of each 2xx, the 400s the
// validators own, the 409 mapping, and the gate. No test here touches a database.
const CAT = "11111111-1111-4111-8111-111111111111";
const LINE = {
  id: "22222222-2222-4222-8222-222222222222",
  occurredOn: "2026-11-08",
  branch: "OTHER",
  type: "COURSE",
  categoryId: CAT,
  categoryName: "Skateboard · Duo",
  productName: "Skateboard · Duo",
  amountMinor: 1100000,
  method: "CASH",
  remark: "[C-TEST] x",
  source: "MANUAL",
  createdAt: "2026-11-08T03:00:00.000Z",
};
const BLOCK = { rows: [{ type: "COURSE", amountMinor: 0 }], totalMinor: 0, refundsMinor: 0 };
const REF = "33333333-3333-4333-8333-333333333333";
const PAY_ID = "44444444-4444-4444-8444-444444444444";
const PAYMENT_1 = (refType: string, refId: string) => ({
  id: PAY_ID,
  refType,
  refId,
  n: 1,
  paidOn: "2026-11-08",
  amountMinor: 950000,
  method: "TRANSFER",
  updatedAt: "2026-11-08T03:00:00.000Z",
});

const calls: Record<string, unknown[]> = {};
const svc = {
  listCategories: mock(async (o: unknown) => {
    (calls.listCategories ??= []).push(o);
    return [{ id: CAT, type: "COURSE", name: "Birthday", sortOrder: 25, active: true }];
  }),
  createCategory: mock(async (i: { type: string; name: string }) => ({
    id: CAT,
    type: i.type,
    name: i.name,
    sortOrder: 0,
    active: true,
  })),
  createManualLine: mock(async (_i: unknown, actor: string | null) => {
    (calls.actor ??= []).push(actor);
    return LINE;
  }),
  listLines: mock(async (f: unknown) => {
    (calls.listLines ??= []).push(f);
    return { lines: [LINE], totalMinor: LINE.amountMinor, revenueMinor: LINE.amountMinor, refundsMinor: 0 };
  }),
  summary: mock(async (date: string) => ({ date, today: BLOCK, mtd: BLOCK, ytd: BLOCK })),
  // TASK-874 — the F2 payment record. Payment rows ONLY: no revenue-line figure anywhere in these shapes.
  listPayments: mock(async (refType: string, refId: string) => ({
    payments: [PAYMENT_1(refType, refId)],
    feeMinor: 950000,
    paidMinor: 950000,
    remainingMinor: 0,
  })),
  createPayment: mock(async (i: { refType: string; refId: string; paidOn: string; amountMinor: number; method: string }, actor: string | null) => {
    (calls.paymentActor ??= []).push(actor);
    return { ...PAYMENT_1(i.refType, i.refId), n: 2, paidOn: i.paidOn, amountMinor: i.amountMinor, method: i.method };
  }),
  updatePayment: mock(async (id: string, patch: Record<string, unknown>, actor: string | null) => {
    (calls.paymentPatch ??= []).push({ id, patch, actor });
    return { ...PAYMENT_1("COURSE", REF), id, ...patch };
  }),
};
mock.module("../services/revenue-ledger.service", () => svc);

const { revenueLedgerRoutes } = await import("./revenue-ledger");

const saved: Record<string, string | undefined> = {};
const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.JWT_SECRET = "test-secret-abc";
  delete process.env.SKIP_ADMIN_AUTH; // unset ⇒ the gate is enforced
});
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
});

const onErr = (err: Error, c: import("hono").Context) => {
  if (err instanceof ApiException)
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  return c.json({ error: { code: "INTERNAL", message: "err" } }, 500);
};
function app() {
  const a = new Hono();
  a.onError(onErr);
  return a.route("/revenue", revenueLedgerRoutes);
}
const auth = async (role: "ceo" | "admin" | "coach" = "ceo") => ({
  Authorization: `Bearer ${await signToken({ sub: "u1", role })}`,
});
const get = async (path: string, headers?: Record<string, string>) =>
  app().request(path, { headers: headers ?? (await auth()) });
const post = async (path: string, body: unknown, headers?: Record<string, string>) =>
  app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? (await auth())) },
    body: JSON.stringify(body),
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = async (r: Response): Promise<any> => r.json();

const goodLine = {
  occurredOn: "2026-11-08",
  branch: "OTHER",
  type: "COURSE",
  categoryId: CAT,
  amountMinor: 1100000,
  method: "CASH",
};

describe("revenue ledger — the gate (SPEC-098 §1.6)", () => {
  const ALL: [string, string][] = [
    ["GET", "/revenue/categories"],
    ["POST", "/revenue/categories"],
    ["POST", "/revenue/lines"],
    ["GET", "/revenue/lines?from=2026-11-01&to=2026-11-08"],
    ["GET", "/revenue/summary?date=2026-11-08"],
  ];
  test.each(ALL)("%s %s with no token → 401 UNAUTHORIZED (SKIP_ADMIN_AUTH unset)", async (method, path) => {
    const res = await app().request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(401);
    expect((await j(res)).error.code).toBe("UNAUTHORIZED");
  });

  test.each(ALL)("%s %s with an ADMIN token → 403 FORBIDDEN (revenue is CEO-only)", async (method, path) => {
    const res = await app().request(path, {
      method,
      headers: { "content-type": "application/json", ...(await auth("admin")) },
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(403);
    expect((await j(res)).error.code).toBe("FORBIDDEN");
  });

  test.each(ALL)("%s %s with a COACH token → 403 FORBIDDEN", async (method, path) => {
    const res = await app().request(path, {
      method,
      headers: { "content-type": "application/json", ...(await auth("coach")) },
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(403);
    expect((await j(res)).error.code).toBe("FORBIDDEN");
  });

  test("a CEO token gets past the gate on every route — 200/201, or a 400 from the validator, never 401/403", async () => {
    for (const [method, path] of ALL) {
      const res = await app().request(path, {
        method,
        headers: { "content-type": "application/json", ...(await auth("ceo")) },
        body: method === "POST" ? "{}" : undefined,
      });
      expect([200, 201, 400]).toContain(res.status);
    }
    expect((await get("/revenue/summary?date=2026-11-08", await auth("ceo"))).status).toBe(200);
  });

  test("a malformed token → 401", async () => {
    const res = await get("/revenue/summary?date=2026-11-08", { Authorization: "Bearer not-a-jwt" });
    expect(res.status).toBe(401);
  });
});

describe("🔑 the guard walk (SPEC-098 §1.6)", () => {
  // `bo.test.ts` walks only `boRoutes`, so it never sees this router. Same idea, on Hono's own route table: a new
  // route added without the gate breaks the build instead of quietly opening the revenue surface.
  const entries = revenueLedgerRoutes.routes;
  const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

  test("the router has the five revenue routes and the three payment routes (so the walk below is not vacuous)", () => {
    const handled = new Set(entries.map(key));
    for (const k of [
      "GET /categories",
      "POST /categories",
      "POST /lines",
      "GET /lines",
      "GET /summary",
      "GET /payments",
      "POST /payments",
      "PATCH /payments/:id",
    ]) {
      expect(handled.has(k)).toBe(true);
    }
  });

  // TASK-874: TWO gates. /payments is ceo OR admin (an admin records payments); everything else stays ceo-only.
  const isPayment = (k: string) => k.split(" ")[1]!.startsWith("/payments");
  const allKeys = [...new Set(entries.map(key))];

  test("every NON-payment method+path has a handler named requireRevenueAccess (ceo-only)", () => {
    const guarded = new Set(entries.filter((r) => r.handler.name === "requireRevenueAccess").map(key));
    expect(allKeys.filter((k) => !isPayment(k)).filter((k) => !guarded.has(k))).toEqual([]);
  });

  test("every /payments method+path has a handler named requirePaymentAccess (ceo or admin)", () => {
    const guarded = new Set(entries.filter((r) => r.handler.name === "requirePaymentAccess").map(key));
    const payments = allKeys.filter(isPayment);
    expect(payments.length).toBe(3);
    expect(payments.filter((k) => !guarded.has(k))).toEqual([]);
  });

  test("the gates never cross: no payment route is behind the ceo-only gate, no revenue route behind the payment gate", () => {
    const ceoOnly = new Set(entries.filter((r) => r.handler.name === "requireRevenueAccess").map(key));
    const payGate = new Set(entries.filter((r) => r.handler.name === "requirePaymentAccess").map(key));
    expect(allKeys.filter(isPayment).filter((k) => ceoOnly.has(k))).toEqual([]);
    expect(allKeys.filter((k) => !isPayment(k)).filter((k) => payGate.has(k))).toEqual([]);
  });
});

describe("the mount in api.ts — the client's real path /api/v1/revenue", () => {
  // The other tests mount the router on their own Hono app; this one goes through `api` itself, so an unmounted or
  // mis-pathed router (404) cannot hide behind green route tests.
  const root = async () => {
    const { api } = await import("./api");
    const a = new Hono();
    a.onError(onErr);
    return a.route("/api", api);
  };
  test("no token → 401 (gated), not 404 (unmounted)", async () => {
    const res = await (await root()).request("/api/v1/revenue/summary?date=2026-11-08");
    expect(res.status).toBe(401);
  });
  test("a ceo token → 200 with the summary shape", async () => {
    const res = await (await root()).request("/api/v1/revenue/summary?date=2026-11-08", { headers: await auth("ceo") });
    expect(res.status).toBe(200);
    expect(Object.keys(await j(res))).toEqual(["date", "today", "mtd", "ytd"]);
  });
  test("an admin token → 403 through the mount too", async () => {
    const res = await (await root()).request("/api/v1/revenue/summary?date=2026-11-08", { headers: await auth("admin") });
    expect(res.status).toBe(403);
  });
});

describe("GET /revenue/categories", () => {
  test("200 { categories: [...] } with the SPEC field names", async () => {
    const res = await get("/revenue/categories");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(Object.keys(body)).toEqual(["categories"]);
    expect(Object.keys(body.categories[0]).sort()).toEqual(["active", "id", "name", "sortOrder", "type"]);
  });
  test("type and includeInactive are passed to the service as parsed values", async () => {
    await get("/revenue/categories?type=FNB&includeInactive=true");
    expect(calls.listCategories[0]).toEqual({ type: "FNB", includeInactive: true });
  });
  test("an unknown type → 400 VALIDATION", async () => {
    const res = await get("/revenue/categories?type=REFUND");
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe("VALIDATION");
  });
});

describe("POST /revenue/categories", () => {
  test("201 { category }", async () => {
    const res = await post("/revenue/categories", { type: "OTHER", name: "  Cap  " });
    expect(res.status).toBe(201);
    const body = await j(res);
    expect(body.category.name).toBe("Cap"); // trimmed
  });
  test("REFUND is not a category type → 400", async () => {
    expect((await post("/revenue/categories", { type: "REFUND", name: "x" })).status).toBe(400);
  });
  test("empty and over-60 names → 400", async () => {
    expect((await post("/revenue/categories", { type: "OTHER", name: "   " })).status).toBe(400);
    expect((await post("/revenue/categories", { type: "OTHER", name: "x".repeat(61) })).status).toBe(400);
  });
  test("a duplicate (type, lower(name)) → 409 CONFLICT", async () => {
    svc.createCategory.mockImplementationOnce(async () => {
      throw conflict("CONFLICT", "duplicate");
    });
    const res = await post("/revenue/categories", { type: "OTHER", name: "bag" });
    expect(res.status).toBe(409);
    expect((await j(res)).error.code).toBe("CONFLICT");
  });
});

describe("POST /revenue/lines (manual line)", () => {
  test("201 { line } with the RevenueLine field names", async () => {
    const res = await post("/revenue/lines", goodLine);
    expect(res.status).toBe(201);
    const { line } = await j(res);
    expect(Object.keys(line).sort()).toEqual(
      [
        "amountMinor",
        "branch",
        "categoryId",
        "categoryName",
        "createdAt",
        "id",
        "method",
        "occurredOn",
        "productName",
        "remark",
        "source",
        "type",
      ].sort(),
    );
    expect(line.source).toBe("MANUAL");
  });
  test("actor is the JWT subject", async () => {
    await post("/revenue/lines", goodLine);
    expect(calls.actor[0]).toBe("u1");
  });
  test.each([
    ["a bad date (2026-02-30)", { ...goodLine, occurredOn: "2026-02-30" }],
    ["a malformed date", { ...goodLine, occurredOn: "8/11/2026" }],
    ["type REFUND (not allowed in POST)", { ...goodLine, type: "REFUND" }],
    ["amount 0", { ...goodLine, amountMinor: 0 }],
    ["a negative amount", { ...goodLine, amountMinor: -5 }],
    ["a fractional amount", { ...goodLine, amountMinor: 10.5 }],
    ["an unknown branch", { ...goodLine, branch: "MOON" }],
    ["an unknown method", { ...goodLine, method: "BARTER" }],
    ["a non-uuid categoryId", { ...goodLine, categoryId: "nope" }],
    ["a remark over 500 chars", { ...goodLine, remark: "r".repeat(501) }],
    ["a productName over 120 chars", { ...goodLine, productName: "p".repeat(121) }],
  ])("400 VALIDATION on %s", async (_name, body) => {
    const res = await post("/revenue/lines", body);
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe("VALIDATION");
  });
});

describe("GET /revenue/lines", () => {
  test("200 { lines, totalMinor, revenueMinor, refundsMinor }", async () => {
    const res = await get("/revenue/lines?from=2026-11-01&to=2026-11-08");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(Object.keys(body).sort()).toEqual(["lines", "refundsMinor", "revenueMinor", "totalMinor"]);
    expect(body.totalMinor).toBe(1100000);
    expect(body.totalMinor).toBe(body.revenueMinor + body.refundsMinor);
  });
  test("a REFUND line in the range: refundsMinor ≤ 0, kept apart, and totalMinor = revenueMinor + refundsMinor", async () => {
    // The service is mocked, so this proves the route passes the three numbers through untouched, not the SQL.
    const REFUND = {
      ...LINE,
      type: "REFUND",
      categoryId: null,
      categoryName: null,
      amountMinor: -50000,
    } as unknown as typeof LINE; // REFUND lines have no category (SPEC §2); LINE's literal type says string
    svc.listLines.mockImplementationOnce(async () => ({
      lines: [LINE, REFUND],
      totalMinor: 1050000,
      revenueMinor: 1100000,
      refundsMinor: -50000,
    }));
    const body = await j(await get("/revenue/lines?from=2026-11-01&to=2026-11-08"));
    expect(body.lines.length).toBe(2);
    expect(body.refundsMinor).toBe(-50000);
    expect(body.refundsMinor).toBeLessThanOrEqual(0);
    expect(body.revenueMinor).toBe(1100000);
    expect(body.totalMinor).toBe(body.revenueMinor + body.refundsMinor);
  });
  test("optional filters reach the service; type may be REFUND", async () => {
    await get(`/revenue/lines?from=2026-11-01&to=2026-11-08&branch=BRAVO&type=REFUND&categoryId=${CAT}`);
    expect(calls.listLines[0]).toEqual({
      from: "2026-11-01",
      to: "2026-11-08",
      branch: "BRAVO",
      type: "REFUND",
      categoryId: CAT,
    });
  });
  test("from and to are required", async () => {
    expect((await get("/revenue/lines")).status).toBe(400);
    expect((await get("/revenue/lines?from=2026-11-01")).status).toBe(400);
  });
  test("from > to → 400", async () => {
    expect((await get("/revenue/lines?from=2026-11-09&to=2026-11-08")).status).toBe(400);
  });
  test("range of exactly 366 days is allowed; 367 → 400", async () => {
    expect((await get("/revenue/lines?from=2026-01-01&to=2027-01-02")).status).toBe(200); // 366 days apart
    const res = await get("/revenue/lines?from=2026-01-01&to=2027-01-03"); // 367 days apart
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe("VALIDATION");
  });
  test("a bad date → 400", async () => {
    expect((await get("/revenue/lines?from=2026-13-01&to=2026-11-08")).status).toBe(400);
  });
});

describe("GET /revenue/summary", () => {
  test("200 { date, today, mtd, ytd } with Block shape", async () => {
    const res = await get("/revenue/summary?date=2026-11-08");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(Object.keys(body)).toEqual(["date", "today", "mtd", "ytd"]);
    expect(Object.keys(body.today).sort()).toEqual(["refundsMinor", "rows", "totalMinor"]);
  });
  test("date is required and must be real → 400", async () => {
    expect((await get("/revenue/summary")).status).toBe(400);
    expect((await get("/revenue/summary?date=2026-02-30")).status).toBe(400);
  });
  test("an unknown branch → 400", async () => {
    expect((await get("/revenue/summary?date=2026-11-08&branch=MOON")).status).toBe(400);
  });
});

// ═══════════════ TASK-874 — the F2 payment record (SPEC-099 §8) ═══════════════
describe("payment routes — who may call them (SPEC-099 §8.5: an admin records payments, never sees revenue)", () => {
  const PAY: [string, string][] = [
    ["GET", `/revenue/payments?refType=COURSE&refId=${REF}`],
    ["POST", "/revenue/payments"],
    ["PATCH", `/revenue/payments/${PAY_ID}`],
  ];
  const callAs = async (role: "ceo" | "admin" | "coach" | null, method: string, path: string, body: unknown = {}) =>
    app().request(path, {
      method,
      headers: { "content-type": "application/json", ...(role ? await auth(role) : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });

  test.each(PAY)("%s %s with no token → 401", async (method, path) => {
    expect((await callAs(null, method, path)).status).toBe(401);
  });
  test.each(PAY)("%s %s with a COACH token → 403 FORBIDDEN", async (method, path) => {
    const res = await callAs("coach", method, path);
    expect(res.status).toBe(403);
    expect((await j(res)).error.code).toBe("FORBIDDEN");
  });
  test.each(PAY)("%s %s with an ADMIN token gets PAST the gate (never 401/403)", async (method, path) => {
    const res = await callAs("admin", method, path);
    expect([200, 201, 400]).toContain(res.status);
  });
  test.each(PAY)("%s %s with a CEO token gets past the gate too", async (method, path) => {
    expect([200, 201, 400]).toContain((await callAs("ceo", method, path)).status);
  });
  test("an ADMIN reads payments (200) but is refused revenue (403): the two gates, side by side", async () => {
    expect((await callAs("admin", "GET", `/revenue/payments?refType=COURSE&refId=${REF}`)).status).toBe(200);
    expect((await callAs("admin", "GET", "/revenue/summary?date=2026-11-08")).status).toBe(403);
    expect((await callAs("admin", "GET", "/revenue/lines?from=2026-11-01&to=2026-11-08")).status).toBe(403);
    expect((await callAs("admin", "GET", "/revenue/categories")).status).toBe(403);
  });
  test("a CEO still reads revenue as before", async () => {
    expect((await callAs("ceo", "GET", "/revenue/summary?date=2026-11-08")).status).toBe(200);
  });
  test("an admin's payment responses hold NO revenue figure: only payment rows and the fee bookkeeping", async () => {
    const list = await j(await callAs("admin", "GET", `/revenue/payments?refType=COURSE&refId=${REF}`));
    expect(Object.keys(list).sort()).toEqual(["feeMinor", "paidMinor", "payments", "remainingMinor"]);
    expect(JSON.stringify(list)).not.toMatch(/revenue|totalMinor|refundsMinor|rl:/i);
    const made = await j(await callAs("admin", "POST", "/revenue/payments", { refType: "COURSE", refId: REF, paidOn: "2026-11-09", amountMinor: 100000, method: "CASH" }));
    expect(JSON.stringify(made)).not.toMatch(/revenue|totalMinor|rl:/i);
  });
});

describe("payment routes — shapes and validation", () => {
  const ceo = () => auth("ceo");
  const send = async (method: string, path: string, body?: unknown) =>
    app().request(path, { method, headers: { "content-type": "application/json", ...(await ceo()) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const good = { refType: "COURSE", refId: REF, paidOn: "2026-11-09", amountMinor: 450000, method: "CASH" };

  test("GET → 200 { payments:[{id,refType,refId,n,paidOn,amountMinor,method,updatedAt}], feeMinor, paidMinor, remainingMinor }", async () => {
    const b = await j(await send("GET", `/revenue/payments?refType=VOUCHER&refId=${REF}`));
    expect(Object.keys(b)).toEqual(["payments", "feeMinor", "paidMinor", "remainingMinor"]);
    expect(Object.keys(b.payments[0]).sort()).toEqual(["amountMinor", "id", "method", "n", "paidOn", "refId", "refType", "updatedAt"]);
    expect(b.payments[0].refType).toBe("VOUCHER");
  });
  test.each([
    ["no refType", `?refId=${REF}`],
    ["no refId", "?refType=COURSE"],
    ["an unknown refType (slice 2a is COURSE and VOUCHER)", `?refType=CAMP&refId=${REF}`],
    ["a non-uuid refId", "?refType=COURSE&refId=nope"],
  ])("GET with %s → 400 VALIDATION", async (_n, qs) => {
    const res = await send("GET", `/revenue/payments${qs}`);
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe("VALIDATION");
  });

  test("POST → 201 { payment } with n from the service, and the actor is the JWT subject", async () => {
    const res = await send("POST", "/revenue/payments", good);
    expect(res.status).toBe(201);
    const { payment } = await j(res);
    expect(payment).toMatchObject({ n: 2, paidOn: "2026-11-09", amountMinor: 450000, method: "CASH", refId: REF });
    expect(calls.paymentActor?.at(-1)).toBe("u1");
  });
  test.each([
    ["a bad method", { ...good, method: "BARTER" }],
    ["amount 0", { ...good, amountMinor: 0 }],
    ["a negative amount", { ...good, amountMinor: -5 }],
    ["a fractional amount", { ...good, amountMinor: 10.5 }],
    ["an impossible date", { ...good, paidOn: "2026-02-30" }],
    ["a malformed date", { ...good, paidOn: "9/11/2026" }],
    ["a non-uuid refId", { ...good, refId: "nope" }],
    ["refType BOOKING (later slice)", { ...good, refType: "BOOKING" }],
    ["a missing field", { refType: "COURSE", refId: REF, amountMinor: 1 }],
  ])("POST with %s → 400 VALIDATION", async (_n, body) => {
    const res = await send("POST", "/revenue/payments", body);
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe("VALIDATION");
  });
  test("POST over the fee → the service's 400 VALIDATION reaches the client", async () => {
    svc.createPayment.mockImplementationOnce(async () => {
      throw badRequest("the installments add up to more than the course fee");
    });
    const res = await send("POST", "/revenue/payments", good);
    expect(res.status).toBe(400);
    expect((await j(res)).error.message).toContain("more than the course fee");
  });
  test("POST with no posted fee → 409 NO_FEE; a lost race on n → 409 CONFLICT", async () => {
    svc.createPayment.mockImplementationOnce(async () => {
      throw conflict("NO_FEE", "no fee");
    });
    const a = await send("POST", "/revenue/payments", good);
    expect(a.status).toBe(409);
    expect((await j(a)).error.code).toBe("NO_FEE");
    svc.createPayment.mockImplementationOnce(async () => {
      throw conflict("CONFLICT", "duplicate n");
    });
    const b = await send("POST", "/revenue/payments", good);
    expect(b.status).toBe(409);
    expect((await j(b)).error.code).toBe("CONFLICT");
  });

  test("PATCH → 200 { payment }; any single field is enough; the actor is the JWT subject", async () => {
    for (const patch of [{ method: "CARD" }, { paidOn: "2026-11-10" }, { amountMinor: 500000 }]) {
      const res = await send("PATCH", `/revenue/payments/${PAY_ID}`, patch);
      expect(res.status).toBe(200);
      expect(Object.keys(await j(res))).toEqual(["payment"]);
    }
    expect(calls.paymentPatch?.at(-1)).toEqual({ id: PAY_ID, patch: { amountMinor: 500000 }, actor: "u1" });
  });
  test("PATCH may change row 1's amount (§8.9: every row's amount is editable): no 'not editable' rule at the route", async () => {
    const res = await send("PATCH", `/revenue/payments/${PAY_ID}`, { amountMinor: 400000 });
    expect(res.status).toBe(200);
  });
  test.each([
    ["an empty patch", {}],
    ["a bad method", { method: "BARTER" }],
    ["amount 0", { amountMinor: 0 }],
    ["a negative amount", { amountMinor: -1 }],
    ["a bad date", { paidOn: "2026-13-01" }],
  ])("PATCH with %s → 400 VALIDATION", async (_n, body) => {
    const res = await send("PATCH", `/revenue/payments/${PAY_ID}`, body);
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe("VALIDATION");
  });
  test("PATCH with a non-uuid id → 400; an unknown payment → the service's 404", async () => {
    expect((await send("PATCH", "/revenue/payments/not-a-uuid", { method: "CASH" })).status).toBe(400);
    svc.updatePayment.mockImplementationOnce(async () => {
      throw new ApiException(404, "NOT_FOUND", "payment not found");
    });
    const res = await send("PATCH", `/revenue/payments/${PAY_ID}`, { method: "CASH" });
    expect(res.status).toBe(404);
  });
  test("there is no DELETE in 2a", async () => {
    expect((await send("DELETE", `/revenue/payments/${PAY_ID}`)).status).toBe(404);
  });
});

// ───────── the real service, DB-free: the rules that live inside the transaction ─────────
// Imported under a query string so it is NOT the module mocked above (mock.module is keyed by the plain path).
describe("payment service — the transactional rules (recording fake, no connection)", () => {
  const spec = "../services/revenue-ledger.service.ts?real";
  type Rec = { op: string; table?: unknown; values?: any; set?: any; where?: any; args: any[] };
  function fakeD(respond: (r: Rec) => unknown) {
    const log: Rec[] = [];
    const mk = (op: string, args: any[], table?: unknown) => {
      const rec: Rec = { op, args, table };
      log.push(rec);
      const p: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") return (res: any, rej: any) => Promise.resolve().then(() => respond(rec)).then(res, rej);
            return (...a: any[]) => {
              if (prop === "from") rec.table = a[0];
              if (prop === "values") rec.values = a[0];
              if (prop === "set") rec.set = a[0];
              if (prop === "where") rec.where = a[0];
              return p;
            };
          },
        },
      );
      return p;
    };
    const tx: any = {
      select: (...a: any[]) => mk("select", a),
      insert: (t: unknown) => mk("insert", [t], t),
      update: (t: unknown) => mk("update", [t], t),
      execute: (s: unknown) => mk("execute", [s]),
    };
    return { d: { ...tx, transaction: async (fn: (t: any) => Promise<unknown>) => fn(tx) }, log };
  }
  const dialect = new PgDialect();
  const paramsOf = (w: unknown): unknown[] => dialect.sqlToQuery(w as any).params;
  const ROW = (n: number, over: Record<string, unknown> = {}) => ({
    id: PAY_ID, refType: "COURSE", refId: REF, n, paidOn: "2026-11-08", amountMinor: 950000, method: "TRANSFER", actor: null,
    createdAt: new Date("2026-11-08T03:00:00Z"), updatedAt: new Date("2026-11-08T03:00:00Z"), ...over,
  });
  const FEE_ROWS = [{ key: `course-sale:${REF}`, valueMinor: 1000000 }, { key: `discount:${REF}`, valueMinor: -50000 }]; // fee = 950,000
  const responder = (o: { rows?: any[]; others?: any[]; moves?: any[]; insertError?: unknown } = {}) => (r: Rec): unknown => {
    if (r.op === "execute") return [];
    if (r.op === "select" && r.table === boMovement) return o.moves ?? FEE_ROWS;
    if (r.op === "select" && r.table === boPayment) {
      const keys = Object.keys(r.args[0] ?? {});
      if (keys.length === 1 && keys[0] === "amountMinor") return o.others ?? [];
      return o.rows ?? [];
    }
    if (r.op === "insert") {
      if (o.insertError) throw o.insertError;
      return [ROW(r.values.n, r.values)];
    }
    if (r.op === "update" && r.table === boPayment) return [{ ...(o.rows ?? [ROW(1)])[0], ...r.set }];
    return [];
  };
  const load = async () => (await import(spec)) as typeof import("../services/revenue-ledger.service");

  test("the real module is not the mocked one (the query-string import is a separate module)", async () => {
    const real = await load();
    expect(real.createPayment).not.toBe(svc.createPayment);
    expect(typeof real.updatePayment).toBe("function");
  });

  describe("the follow rule (SPEC-099 §8.4): row 1's METHOD moves the revenue line, in the same transaction", () => {
    test("a method change on ROW 1 updates the matching revenue line (key rl:course:<id>) after updating the payment", async () => {
      const { updatePayment } = await load();
      const { d, log } = fakeD(responder({ rows: [ROW(1)] }));
      await updatePayment(PAY_ID, { method: "CASH" }, "u1", d);
      const ups = log.filter((r) => r.op === "update");
      expect(ups.map((r) => r.table)).toEqual([boPayment, boRevenueLine]); // payment first, then the line
      expect(ups[1]!.set).toEqual({ method: "CASH" });
      expect(paramsOf(ups[1]!.where)).toContain(`rl:course:${REF}`);
    });
    test("for a VOUCHER the key is rl:voucher:<id>", async () => {
      const { updatePayment } = await load();
      const { d, log } = fakeD(responder({ rows: [ROW(1, { refType: "VOUCHER" })] }));
      await updatePayment(PAY_ID, { method: "CARD" }, "u1", d);
      expect(paramsOf(log.filter((r) => r.table === boRevenueLine)[0]!.where)).toContain(`rl:voucher:${REF}`);
    });
    test("an INSTALLMENT (n >= 2) method change never touches the revenue line", async () => {
      const { updatePayment } = await load();
      for (const n of [2, 3, 7]) {
        const { d, log } = fakeD(responder({ rows: [ROW(n)] }));
        await updatePayment(PAY_ID, { method: "CASH" }, "u1", d);
        expect(log.some((r) => r.table === boRevenueLine)).toBe(false);
      }
    });
    test("row 1's date or amount change never touches the line either (only the METHOD follows)", async () => {
      const { updatePayment } = await load();
      const { d, log } = fakeD(responder({ rows: [ROW(1)] }));
      await updatePayment(PAY_ID, { paidOn: "2026-11-12", amountMinor: 900000 }, "u1", d);
      expect(log.some((r) => r.table === boRevenueLine)).toBe(false);
    });
    test("the payment and the line are written inside ONE transaction, after the advisory lock", async () => {
      const { updatePayment } = await load();
      let transactions = 0;
      const { d, log } = fakeD(responder({ rows: [ROW(1)] }));
      const counted = { ...d, transaction: async (fn: any) => ((transactions += 1), d.transaction(fn)) };
      await updatePayment(PAY_ID, { method: "CASH" }, "u1", counted);
      expect(transactions).toBe(1);
      expect(log.findIndex((r) => r.op === "execute")).toBeLessThan(log.findIndex((r) => r.op === "update"));
    });
    test("the response is a payment, with no revenue-line data", async () => {
      const { updatePayment } = await load();
      const { d } = fakeD(responder({ rows: [ROW(1)] }));
      const out = await updatePayment(PAY_ID, { method: "CASH" }, "u1", d);
      expect(Object.keys(out).sort()).toEqual(["amountMinor", "id", "method", "n", "paidOn", "refId", "refType", "updatedAt"]);
      expect(out.method).toBe("CASH");
    });
  });

  describe("PATCH: the fee rules (SPEC-099 §8.9)", () => {
    test("an amount that keeps sum(rows) <= fee is accepted; the actor and updatedAt are stamped", async () => {
      const { updatePayment } = await load();
      const { d, log } = fakeD(responder({ rows: [ROW(1)], others: [{ amountMinor: 400000 }] })); // others 400,000 + new 550,000 = 950,000 = fee
      await updatePayment(PAY_ID, { amountMinor: 550000 }, "staff-7", d);
      const up = log.find((r) => r.op === "update" && r.table === boPayment)!;
      expect(up.set).toMatchObject({ amountMinor: 550000, actor: "staff-7" });
      expect(up.set.updatedAt).toBeInstanceOf(Date);
    });
    test("an amount that pushes the sum over the fee → 400 VALIDATION, and nothing is written", async () => {
      const { updatePayment } = await load();
      const { d, log } = fakeD(responder({ rows: [ROW(1)], others: [{ amountMinor: 400000 }] })); // 400,000 + 550,001 > 950,000
      const err = await updatePayment(PAY_ID, { amountMinor: 550001 }, "u1", d).catch((e) => e);
      expect(err).toBeInstanceOf(ApiException);
      expect([err.status, err.code]).toEqual([400, "VALIDATION"]);
      expect(err.message).toContain("more than the course fee");
      expect(log.some((r) => r.op === "update")).toBe(false);
    });
    test("an amount change on a sale with no posted fee → 409 NO_FEE", async () => {
      const { updatePayment } = await load();
      const { d } = fakeD(responder({ rows: [ROW(1)], moves: [] }));
      const err = await updatePayment(PAY_ID, { amountMinor: 1000 }, "u1", d).catch((e) => e);
      expect([err.status, err.code]).toEqual([409, "NO_FEE"]);
    });
    test("a method or date change needs no fee (it does not touch the sum)", async () => {
      const { updatePayment } = await load();
      const { d } = fakeD(responder({ rows: [ROW(1)], moves: [] }));
      await expect(updatePayment(PAY_ID, { paidOn: "2026-11-12" }, "u1", d)).resolves.toBeDefined();
    });
    test("an unknown payment → 404", async () => {
      const { updatePayment } = await load();
      const { d } = fakeD(responder({ rows: [] }));
      const err = await updatePayment(PAY_ID, { method: "CASH" }, "u1", d).catch((e) => e);
      expect(err.status).toBe(404);
    });
  });

  describe("POST: n = max + 1, the fee, the race", () => {
    const input = { refType: "COURSE" as const, refId: REF, paidOn: "2026-11-09", amountMinor: 450000, method: "CASH" as const };
    test("n is max(n) + 1 for that sale, inside one transaction after the advisory lock", async () => {
      const { createPayment } = await load();
      const { d, log } = fakeD(responder({ rows: [{ n: 1, amountMinor: 500000 }, { n: 3, amountMinor: 0 }] }));
      const out = await createPayment(input, "u1", d);
      expect(out.n).toBe(4);
      const ins = log.find((r) => r.op === "insert")!;
      expect(ins.values).toMatchObject({ refType: "COURSE", refId: REF, n: 4, amountMinor: 450000, method: "CASH", paidOn: "2026-11-09", actor: "u1" });
      expect(log[0]!.op).toBe("execute"); // the per-sale lock is the first statement
    });
    test("the first row for a sale is n = 1", async () => {
      const { createPayment } = await load();
      const { d } = fakeD(responder({ rows: [] }));
      expect((await createPayment({ ...input, amountMinor: 950000 }, null, d)).n).toBe(1);
    });
    test("sum(rows) + the new amount over the fee → 400 VALIDATION and no insert", async () => {
      const { createPayment } = await load();
      const { d, log } = fakeD(responder({ rows: [{ n: 1, amountMinor: 950000 }] })); // already the whole fee
      const err = await createPayment(input, "u1", d).catch((e) => e);
      expect([err.status, err.code]).toEqual([400, "VALIDATION"]);
      expect(log.some((r) => r.op === "insert")).toBe(false);
    });
    test("exactly the remaining fee is accepted (the boundary is inclusive)", async () => {
      const { createPayment } = await load();
      const { d } = fakeD(responder({ rows: [{ n: 1, amountMinor: 500000 }] }));
      await expect(createPayment({ ...input, amountMinor: 450000 }, "u1", d)).resolves.toBeDefined();
    });
    test("no posted fee → 409 NO_FEE and no insert (also stops a payment on a made-up sale id)", async () => {
      const { createPayment } = await load();
      const { d, log } = fakeD(responder({ rows: [], moves: [] }));
      const err = await createPayment(input, "u1", d).catch((e) => e);
      expect([err.status, err.code]).toEqual([409, "NO_FEE"]);
      expect(log.some((r) => r.op === "insert")).toBe(false);
    });
    test("a discount-only movement is not a fee (the sale movement must be there)", async () => {
      const { createPayment } = await load();
      const { d } = fakeD(responder({ rows: [], moves: [{ key: `discount:${REF}`, valueMinor: -50000 }] }));
      expect(((await createPayment(input, "u1", d).catch((e) => e)) as any).code).toBe("NO_FEE");
    });
    test("a duplicate n (the unique index fired: a lost race) → 409 CONFLICT", async () => {
      const { createPayment } = await load();
      const { d } = fakeD(responder({ rows: [], insertError: Object.assign(new Error("duplicate key"), { code: "23505" }) }));
      const err = await createPayment(input, "u1", d).catch((e) => e);
      expect([err.status, err.code]).toEqual([409, "CONFLICT"]);
    });
    test("any other database error is not turned into a 409", async () => {
      const { createPayment } = await load();
      const { d } = fakeD(responder({ rows: [], insertError: new Error("boom") }));
      const err = await createPayment(input, "u1", d).catch((e) => e);
      expect(err).not.toBeInstanceOf(ApiException);
    });
  });

  describe("GET: the fee bookkeeping the screen shows (it sums nothing itself)", () => {
    test("rows ordered by n, with feeMinor = sale + discount, paidMinor = sum, remainingMinor = fee − paid", async () => {
      const { listPayments } = await load();
      const { d } = fakeD(responder({ rows: [ROW(1, { amountMinor: 500000 }), ROW(2, { amountMinor: 250000 })] }));
      const out = await listPayments("COURSE", REF, d);
      expect(out.payments.map((p) => p.n)).toEqual([1, 2]);
      expect([out.feeMinor, out.paidMinor, out.remainingMinor]).toEqual([950000, 750000, 200000]);
    });
    test("a voucher's fee reads voucher-sale:<id> + discount:<id>", async () => {
      const { listPayments } = await load();
      const moves = [{ key: `voucher-sale:${REF}`, valueMinor: 1050000 }];
      const { d } = fakeD(responder({ rows: [ROW(1, { refType: "VOUCHER", amountMinor: 1050000 })], moves }));
      const out = await listPayments("VOUCHER", REF, d);
      expect([out.feeMinor, out.paidMinor, out.remainingMinor]).toEqual([1050000, 1050000, 0]);
    });
    test("no posted fee → feeMinor null and remainingMinor null (the card shows the rows only)", async () => {
      const { listPayments } = await load();
      const { d } = fakeD(responder({ rows: [ROW(1, { amountMinor: 123 })], moves: [] }));
      const out = await listPayments("COURSE", REF, d);
      expect([out.feeMinor, out.paidMinor, out.remainingMinor]).toEqual([null, 123, null]);
    });
    test("no rows yet → empty list, paid 0", async () => {
      const { listPayments } = await load();
      const { d } = fakeD(responder({ rows: [] }));
      const out = await listPayments("COURSE", REF, d);
      expect(out.payments).toEqual([]);
      expect(out.paidMinor).toBe(0);
    });
    test("GET is read-only: it runs no write and no transaction", async () => {
      const { listPayments } = await load();
      const { d, log } = fakeD(responder({ rows: [ROW(1)] }));
      await listPayments("COURSE", REF, d);
      expect(log.some((r) => r.op === "insert" || r.op === "update" || r.op === "execute")).toBe(false);
    });
  });
});
