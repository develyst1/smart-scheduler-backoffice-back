// TASK-928 (REQ-120 R3.8) — the Sales History read, DB-free: the window rules, the row shape (no money, ever), the query's filters / order / limit by source, the route gates. Each test must fail when its code
// is removed (mutation set: stock-sales-task928.mutations.json). The SQL itself (Bangkok day, joins, stock-only) is proven on sid in a rolled-back run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { signToken, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";
import { SALES_LIMIT_MAX, listSales } from "./stock-read.service";
import { salesQuery, stockRoutes } from "../routes/stock";

const file = async (p: string) => (await Bun.file(new URL(p, import.meta.url)).text()).replace(/\r\n/g, "\n");

/** A fake executor: every builder method returns the builder; `.limit()` resolves the next preset result (1st = the sales rows, 2nd = the buyers). */
function fakeExec(results: unknown[][]) {
  const calls: string[] = [];
  const next = () => results.shift() ?? [];
  const b: any = new Proxy({}, { get: (_t, k: string) => (k === "limit" ? async () => (calls.push("limit"), next()) : (..._a: unknown[]) => (calls.push(k), b)) });
  return { exec: b as never, calls };
}
const ROW = { id: "l-1", saleId: "s-1", day: "2026-10-14", itemId: "i-1", code: "C-1", name: "Helmet", qty: 2, buyer: "Khun A", method: "CASH", branch: "BRAVO" };

describe("the window — real days, from ≤ to, at most 366 days; refused BEFORE any query", () => {
  const bad: Array<[string, string]> = [["2026-02-30", "2026-03-01"], ["2026-13-01", "2026-03-01"], ["x", "2026-03-01"], ["2026-11-09", "2026-11-01"], ["2025-01-01", "2026-11-09"], ["2025-01-01", "2026-01-02"]];
  for (const [from, to] of bad) {
    test(`${from} → ${to} is a 400`, async () => {
      const f = fakeExec([]);
      const err = await listSales({ from, to, limit: 10 }, f.exec).catch((e) => e);
      expect(err).toBeInstanceOf(ApiException);
      expect([err.status, err.code]).toEqual([400, "VALIDATION"]);
      expect(f.calls).toEqual([]); // nothing was queried
    });
  }
  test("a 366-day window (365 apart, inclusive) and a single day are accepted", async () => {
    await listSales({ from: "2025-11-09", to: "2026-11-09", limit: 10 }, fakeExec([[], []]).exec);
    await listSales({ from: "2026-11-09", to: "2026-11-09", limit: 10 }, fakeExec([[], []]).exec);
  });
});

describe("the rows — shape, no money, the customer list", () => {
  test("each row: id, saleId, occurredOn, itemId, code, name, qty, customer, payment, branch — and the buyers of the window as `customers`", async () => {
    const f = fakeExec([[ROW, { ...ROW, id: "l-2", buyer: null, method: null, code: null }], [{ buyer: "Khun A" }, { buyer: "Khun B" }]]);
    const r = await listSales({ from: "2026-10-01", to: "2026-10-31", limit: 50 }, f.exec);
    expect(r.items[0]).toEqual({ id: "l-1", saleId: "s-1", occurredOn: "2026-10-14", itemId: "i-1", code: "C-1", name: "Helmet", qty: 2, customer: "Khun A", payment: "CASH", branch: "BRAVO" });
    expect(r.items[1]).toMatchObject({ customer: null, payment: null, code: "" });
    expect(r.customers).toEqual(["Khun A", "Khun B"]);
    expect(Object.keys(r).sort()).toEqual(["customers", "items"]);
  });
  test("🔑 NO money anywhere: the response has no price / discount / commission / amount / total key, and the query never selects one", async () => {
    const r = await listSales({ from: "2026-10-01", to: "2026-10-31", limit: 50 }, fakeExec([[ROW], []]).exec);
    expect(JSON.stringify(r)).not.toMatch(/price|minor|satang|discount|commission|amount|total|value|revenue|baht/i);
    const S = (await file("./stock-read.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    const sales = S.slice(S.indexOf("export async function listSales"), S.indexOf("export { MOVEMENT_TYPES }"));
    for (const word of ["unitPriceMinor", "discountMinor", "commissionMinor", "valueMinor", "amountMinor"]) expect(sales).not.toContain(word);
  });
  test("an empty window is a valid, empty answer", async () => {
    expect(await listSales({ from: "2026-10-01", to: "2026-10-31", limit: 10 }, fakeExec([[], []]).exec)).toEqual({ items: [], customers: [] });
  });
});

describe("the query, by source — stock products only, the Bangkok day, newest first, the limit, the filters", () => {
  test("window on the BANGKOK day of sold_at, inclusive; stock products only; newest first (sold_at then line id); the limit is applied", async () => {
    const S = (await file("./stock-read.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    const q = S.slice(S.indexOf("export async function listSales"), S.indexOf("export { MOVEMENT_TYPES }"));
    expect(S).toContain("const SALE_DAY = sql`to_char(${boSale.soldAt} at time zone 'Asia/Bangkok', 'YYYY-MM-DD')`;");
    expect(q).toContain("${SALE_DAY} >= ${query.from} and ${SALE_DAY} <= ${query.to}");
    expect(q).toContain("eq(boItem.externalSource, STOCK_SOURCE)");
    expect(q).toContain(".orderBy(desc(boSale.soldAt), desc(boSaleLine.id))");
    expect(q).toContain(".limit(query.limit)");
  });
  test("q searches the product name, the model code AND the buyer (escaped); the customer filter is an exact match; the customers list is the WINDOW's distinct buyers", async () => {
    const S = (await file("./stock-read.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    const q = S.slice(S.indexOf("export async function listSales"), S.indexOf("export { MOVEMENT_TYPES }"));
    expect(q).toContain("ilike(boItem.name, `%${escapeLike(term)}%`), ilike(boItem.externalRef, `%${escapeLike(term)}%`), ilike(boSale.buyerRef, `%${escapeLike(term)}%`)");
    expect(q).toContain("customer ? eq(boSale.buyerRef, customer) : undefined");
    expect(q).toContain(".selectDistinct({ buyer: boSale.buyerRef })");
    expect(q).toContain("is not null and btrim(${boSale.buyerRef}) <> ''");
    expect(q).toContain(".where(and(inWindow,"); // the buyers list uses the SAME window + stock-only filter, not the page
  });
  test("the executor is queried twice (rows, buyers) and the rows come first", async () => {
    const f = fakeExec([[ROW], [{ buyer: "Khun A" }]]);
    await listSales({ from: "2026-10-01", to: "2026-10-31", limit: 5 }, f.exec);
    expect(f.calls.filter((c) => c === "limit")).toHaveLength(2);
    expect(f.calls.indexOf("selectDistinct")).toBeGreaterThan(f.calls.indexOf("select"));
  });
});

describe("the route", () => {
  test("salesQuery: from / to required real-looking days, limit 1…1000 default 200 (coerced), q / customer ≤ 100", () => {
    expect(salesQuery.parse({ from: "2026-10-01", to: "2026-10-31" })).toEqual({ from: "2026-10-01", to: "2026-10-31", limit: 200 });
    expect(salesQuery.parse({ from: "2026-10-01", to: "2026-10-31", limit: "50", q: "x", customer: "A" }).limit).toBe(50);
    for (const bad of [{}, { from: "2026-10-01" }, { to: "2026-10-31" }, { from: "10/01/2026", to: "2026-10-31" }, { from: "2026-10-01", to: "2026-10-31", limit: 0 }, { from: "2026-10-01", to: "2026-10-31", limit: SALES_LIMIT_MAX + 1 }, { from: "2026-10-01", to: "2026-10-31", q: "x".repeat(101) }])
      expect(salesQuery.safeParse(bad).success).toBe(false);
    expect(SALES_LIMIT_MAX).toBe(1000);
  });
  test("GET /stock/sales is ceo + admin (adminAuth) — one line, tagged", async () => {
    const R = (await file("../routes/stock.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(R).toContain('.get("/sales", adminAuth, zValidator("query", salesQuery), async (c) => c.json(await listSales(c.req.valid("query"))))');
  });

  const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; process.env.JWT_SECRET = "test-secret-928"; process.env.SKIP_ADMIN_AUTH = "false"; });
  afterAll(() => { for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])); });
  const app = () => {
    const a = new Hono();
    a.onError((e, c) => (e instanceof ApiException ? c.json({ error: { code: e.code } }, e.status as 400) : c.json({ error: "internal" }, 500)));
    return a.route("/stock", stockRoutes);
  };
  const get = async (role: Role | null, qs = "?from=2026-10-01&to=2026-10-31") => app().request(`/stock/sales${qs}`, { headers: role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {} });
  test("🔑 no token 401 and a COACH 403 (before any query)", async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get("coach")).status).toBe(403);
  });
  test("an admin and the CEO pass the gate: a bad window is the SERVICE's 400, a missing parameter the validator's 400", async () => {
    for (const role of ["admin", "ceo"] as Role[]) {
      expect((await get(role, "?from=2026-11-09&to=2026-11-01")).status).toBe(400);
      expect((await get(role, "?from=2026-11-09")).status).toBe(400);
    }
  });
});
