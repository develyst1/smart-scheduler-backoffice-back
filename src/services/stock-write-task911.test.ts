// TASK-911 - product create / edit, Stock IN, and the movement business date (`occurred_on`). DB-less: an in-memory StockStore that implements 904's StockTx.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ApiException } from "../lib/http";
import { signToken, type Role } from "../lib/jwt";
import { bangkokDate, movementTypeOf } from "../lib/stock-read";
import { stockRoutes } from "../routes/stock";
import { createStockOutService, type StockOutStore, type StockOutTx } from "./stock-out.service";
import type { StockStore, StockTx } from "./stock-import.service";
import { createStockWriteService } from "./stock-write.service";

const SALES_CAT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_CAT = "aaaaaaaa-0000-4000-8000-000000000002";
const COURSE_CAT = "aaaaaaaa-0000-4000-8000-000000000003"; // a COURSE category is not on the product picker
const CATEGORIES = [{ id: SALES_CAT, type: "SALES", name: "Product sales" }, { id: OTHER_CAT, type: "OTHER", name: "Other" }, { id: COURSE_CAT, type: "COURSE", name: "Course" }];
interface P { id: string; model: string; name: string; priceMinor: number | null; qty: number | null; category: string | null; commissionGroup: string | null; note: string | null; active: boolean; revenueCategoryId: string | null }
interface M { itemId: string; qty: number; remainingAfter: number; refType: string; occurredOn: string | undefined; key: string; actor: string | null | undefined; reason: string }

function memory() {
  const products: P[] = [];
  const movements: M[] = [];
  let n = 0;
  const tx: StockTx = {
    products: async () => products.map((p) => ({ ...p })) as never, // (StockProduct has the same fields we use here)
    batchApplied: async () => false,
    createProduct: async (p) => {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      products.push({ id, model: p.model, name: p.name, priceMinor: p.priceMinor, qty: 0, category: p.category, commissionGroup: p.commissionGroup, note: p.note, active: p.active ?? true, revenueCategoryId: p.revenueCategoryId ?? null });
      return id;
    },
    updateProduct: async (id, patch) => {
      const p = products.find((x) => x.id === id)!;
      if (patch.name !== undefined) p.name = patch.name;
      if (patch.priceMinor !== undefined) p.priceMinor = patch.priceMinor;
      if (patch.category !== undefined) p.category = patch.category;
      if (patch.commissionGroup !== undefined) p.commissionGroup = patch.commissionGroup;
      if (patch.active !== undefined) p.active = patch.active;
      if (patch.revenueCategoryId !== undefined) p.revenueCategoryId = patch.revenueCategoryId;
    },
    addMovement: async (id, m) => {
      products.find((x) => x.id === id)!.qty = m.remainingAfter;
      movements.push({ itemId: id, qty: m.qty, remainingAfter: m.remainingAfter, refType: m.refType ?? "STOCK_IMPORT", occurredOn: m.occurredOn, key: m.idempotencyKey, actor: m.actor, reason: m.reason });
    },
    countKey: async (prefix) => movements.filter((m) => m.key.startsWith(prefix)).length,
    revenueCategories: async () => CATEGORIES,
  };
  const store: StockStore = { products: async () => tx.products(), transaction: async (fn) => fn(tx) };
  return { products, movements, store };
}
const NOW = new Date("2026-11-09T05:00:00Z"); // Bangkok 12:00, 2026-11-09
const setup = () => {
  const mem = memory();
  return { ...mem, svc: createStockWriteService(mem.store, () => NOW) };
};
const base = { code: "SB-001", name: "Skate Bag", category: "Bag", priceSatang: 59_000, commissionGroup: "Bag group", active: true, openingQuantity: 5, revenueCategoryId: SALES_CAT };
const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiException);
    expect((e as ApiException).status).toBe(status);
    if (code) expect((e as ApiException).code).toBe(code);
    return e as ApiException;
  }
  throw new Error("expected a rejection");
};

describe("create a product (POST /stock/products)", () => {
  test("one product, its category and commission group NAME, and ONE opening movement (an ADJUSTMENT, value-free, today)", async () => {
    const { svc, products, movements } = setup();
    const p = await svc.createProduct(base, "ceo-1");
    expect(p).toMatchObject({ code: "SB-001", name: "Skate Bag", category: "Bag", priceSatang: 59_000, quantity: 5, commissionGroup: { name: "Bag group", amountSatang: null }, active: true });
    expect(products).toHaveLength(1);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ qty: 5, remainingAfter: 5, refType: "STOCK_OPENING", occurredOn: "2026-11-09", actor: "ceo-1" });
    expect(movementTypeOf({ qty: 5, refType: "STOCK_OPENING" })).toBe("ADJUSTMENT"); // reads as an opening/adjustment, not a delivery
  });
  test("a zero opening quantity writes NO movement; commissionGroup / category may be null; inactive is stored", async () => {
    const { svc, movements } = setup();
    const p = await svc.createProduct({ ...base, openingQuantity: 0, commissionGroup: null, category: null, active: false }, null);
    expect(p).toMatchObject({ quantity: 0, commissionGroup: null, category: null, active: false });
    expect(movements).toHaveLength(0);
  });
  test("a duplicate code (case-insensitive, trimmed) is 409 DUPLICATE_CODE naming it; nothing is written", async () => {
    const { svc, products, movements } = setup();
    await svc.createProduct(base, null);
    const e = await rejects(svc.createProduct({ ...base, code: "  sb-001 ", name: "Other" }, null), 409, "DUPLICATE_CODE");
    expect(e.details).toEqual({ code: "sb-001" });
    expect(products).toHaveLength(1);
    expect(movements).toHaveLength(1);
  });
  test("validation: price integer satang >= 0, opening whole >= 0, code <= 64, name <= 200, both non-empty", async () => {
    const { svc, products } = setup();
    await rejects(svc.createProduct({ ...base, priceSatang: -1 }, null), 400);
    await rejects(svc.createProduct({ ...base, priceSatang: 10.5 }, null), 400);
    await rejects(svc.createProduct({ ...base, openingQuantity: 1.5 }, null), 400);
    await rejects(svc.createProduct({ ...base, openingQuantity: -1 }, null), 400);
    await rejects(svc.createProduct({ ...base, code: "x".repeat(65) }, null), 400);
    await rejects(svc.createProduct({ ...base, name: "n".repeat(201) }, null), 400);
    await rejects(svc.createProduct({ ...base, code: "  " }, null), 400);
    await rejects(svc.createProduct({ ...base, name: "" }, null), 400);
    expect(products).toHaveLength(0);
  });
});

describe("🔻 row 21: the revenue category on the product form", () => {
  test("create stores revenueCategoryId and returns it", async () => {
    const { svc, products } = setup();
    expect(await svc.createProduct(base, null)).toMatchObject({ revenueCategoryId: SALES_CAT });
    expect(products).toHaveLength(1);
  });
  test("REQUIRED on create: a missing one is 400 and nothing is written", async () => {
    const { svc, products } = setup();
    const { revenueCategoryId: _drop, ...without } = base;
    await rejects(svc.createProduct(without as never, null), 400);
    await rejects(svc.createProduct({ ...base, revenueCategoryId: "" }, null), 400);
    expect(products).toHaveLength(0);
  });
  test("an unknown id, or a category that is not on the picker (COURSE), is 400 UNKNOWN_REVENUE_CATEGORY; nothing is written", async () => {
    const { svc, products, movements } = setup();
    for (const id of ["aaaaaaaa-0000-4000-8000-0000000000ff", COURSE_CAT]) {
      const e = await rejects(svc.createProduct({ ...base, revenueCategoryId: id }, null), 400, "UNKNOWN_REVENUE_CATEGORY");
      expect(e.details).toEqual({ field: "revenueCategoryId" });
    }
    expect(products).toHaveLength(0);
    expect(movements).toHaveLength(0);
  });
  test("edit can CHANGE it (a valid one), refuses an unknown one, and a patch without it leaves it alone", async () => {
    const { svc } = setup();
    const { id } = await svc.createProduct(base, null);
    expect((await svc.editProduct(id, { revenueCategoryId: OTHER_CAT })).revenueCategoryId).toBe(OTHER_CAT);
    await rejects(svc.editProduct(id, { revenueCategoryId: "aaaaaaaa-0000-4000-8000-0000000000ff" }), 400, "UNKNOWN_REVENUE_CATEGORY");
    expect((await svc.editProduct(id, { name: "renamed" })).revenueCategoryId).toBe(OTHER_CAT);
  });
});

describe("edit a product (PATCH /stock/products/:id): a field edit, never a balance change", () => {
  test("name / price / category / commission group / active change; NO movement; the balance is untouched", async () => {
    const { svc, products, movements } = setup();
    const { id } = await svc.createProduct(base, null);
    const before = movements.length;
    const p = await svc.editProduct(id, { name: "Skate Bag v2", priceSatang: 69_000, category: "Gear", commissionGroup: null, active: false });
    expect(p).toMatchObject({ name: "Skate Bag v2", priceSatang: 69_000, category: "Gear", commissionGroup: null, active: false, quantity: 5 });
    expect(products[0]).toMatchObject({ name: "Skate Bag v2", priceMinor: 69_000, qty: 5, active: false });
    expect(movements.length).toBe(before);
  });
  test("a partial edit leaves the other fields; an unknown id is 404; an empty or invalid edit is 400", async () => {
    const { svc } = setup();
    const { id } = await svc.createProduct(base, null);
    expect(await svc.editProduct(id, { priceSatang: 1 })).toMatchObject({ name: "Skate Bag", priceSatang: 1, category: "Bag", commissionGroup: { name: "Bag group" } });
    await rejects(svc.editProduct("99999999-9999-4999-8999-999999999999", { name: "x" }), 404, "UNKNOWN_ITEM");
    await rejects(svc.editProduct(id, {}), 400);
    await rejects(svc.editProduct(id, { priceSatang: -5 }), 400);
    await rejects(svc.editProduct(id, { name: "  " }), 400);
  });
});

describe("Stock IN (POST /stock/in)", () => {
  const key = "receipt-2026-11-09-001";
  async function withItems() {
    const s = setup();
    const a = await s.svc.createProduct({ ...base, code: "A", openingQuantity: 3 }, null);
    const b = await s.svc.createProduct({ ...base, code: "B", openingQuantity: 0 }, null);
    s.movements.length = 0;
    return { ...s, a, b };
  }
  test("one STOCK_IN movement per line: +qty, the balance raised, occurred_on = receivedOn (back-dated), no cost; reads as STOCK_IN", async () => {
    const { svc, movements, products, a, b } = await withItems();
    const r = await svc.stockIn({ idempotencyKey: key, receivedOn: "2026-11-05", lines: [{ itemId: a.id, qty: 4 }, { itemId: b.id, qty: 10 }] }, "admin-1");
    expect(r).toEqual({ receiptId: key, movementsWritten: 2, receivedOn: "2026-11-05" });
    expect(products.map((p) => p.qty)).toEqual([7, 10]);
    expect(movements.map((m) => [m.qty, m.remainingAfter, m.refType, m.occurredOn, m.actor])).toEqual([[4, 7, "STOCK_IN", "2026-11-05", "admin-1"], [10, 10, "STOCK_IN", "2026-11-05", "admin-1"]]);
    expect(movementTypeOf({ qty: 4, refType: "STOCK_IN" })).toBe("STOCK_IN");
    expect(Object.keys(r).sort()).toEqual(["movementsWritten", "receiptId", "receivedOn"]); // no price / cost / totals
  });
  test("idempotent: the same key again writes nothing and answers alreadyApplied", async () => {
    const { svc, movements, products, a } = await withItems();
    const body = { idempotencyKey: key, receivedOn: "2026-11-09", lines: [{ itemId: a.id, qty: 4 }] };
    await svc.stockIn(body, null);
    const again = await svc.stockIn(body, null);
    expect(again).toEqual({ receiptId: key, movementsWritten: 1, receivedOn: "2026-11-09", alreadyApplied: true });
    expect(movements).toHaveLength(1);
    expect(products[0]!.qty).toBe(7);
  });
  test("an unknown or inactive product refuses the WHOLE receipt: nothing is written", async () => {
    const { svc, movements, products, a, b } = await withItems();
    await rejects(svc.stockIn({ idempotencyKey: key, receivedOn: "2026-11-09", lines: [{ itemId: a.id, qty: 1 }, { itemId: "99999999-9999-4999-8999-999999999999", qty: 1 }] }, null), 404, "UNKNOWN_ITEM");
    await svc.editProduct(b.id, { active: false });
    await rejects(svc.stockIn({ idempotencyKey: key, receivedOn: "2026-11-09", lines: [{ itemId: a.id, qty: 1 }, { itemId: b.id, qty: 1 }] }, null), 409, "ITEM_INACTIVE");
    expect(movements).toHaveLength(0);
    expect(products.map((p) => p.qty)).toEqual([3, 0]);
  });
  test("validation: receivedOn a real day and not in the future; whole qty > 0; no duplicate product; at least one line", async () => {
    const { svc, a } = await withItems();
    const ok = { idempotencyKey: key, receivedOn: "2026-11-09", lines: [{ itemId: a.id, qty: 1 }] };
    await rejects(svc.stockIn({ ...ok, receivedOn: "2026-11-10" }, null), 400); // tomorrow (Bangkok)
    await rejects(svc.stockIn({ ...ok, receivedOn: "2026-02-30" }, null), 400);
    await rejects(svc.stockIn({ ...ok, receivedOn: "yesterday" }, null), 400);
    await rejects(svc.stockIn({ ...ok, lines: [{ itemId: a.id, qty: 0 }] }, null), 400);
    await rejects(svc.stockIn({ ...ok, lines: [{ itemId: a.id, qty: 1.5 }] }, null), 400);
    await rejects(svc.stockIn({ ...ok, lines: [{ itemId: a.id, qty: 1 }, { itemId: a.id, qty: 2 }] }, null), 400);
    await rejects(svc.stockIn({ ...ok, lines: [] }, null), 400);
  });
});

describe("the movement business date", () => {
  test("bangkokDate: the Bangkok calendar day of an instant (UTC+7)", () => {
    expect(bangkokDate(new Date("2026-11-05T18:30:00Z"))).toBe("2026-11-06");
    expect(bangkokDate(new Date("2026-11-05T16:59:59Z"))).toBe("2026-11-05");
    expect(bangkokDate(new Date("2026-12-31T17:00:00Z"))).toBe("2027-01-01");
  });
  test("Stock OUT stamps occurred_on = the SALE's Bangkok day (a back-dated sale lands on its own day)", async () => {
    const seen: Array<{ occurredOn?: string }> = [];
    const tx: StockOutTx = {
      lockItems: async (ids) => ids.map((id) => ({ id, model: "A", name: "A", qty: 10, active: true, revenueCategoryId: "rc-1" })), // 🔻 TASK-909: a sale needs the product's revenue category
      saleByKey: async () => null,
      insertSale: async () => "sale-1",
      addSaleMovement: async (m) => {
        seen.push({ occurredOn: m.occurredOn });
        return "mv-1";
      },
      insertSaleLine: async () => "line-1", // 🔻 TASK-909: returns the line id
      postLineRevenue: async () => ({ written: true }), // 🔻 TASK-909: the line's revenue
    };
    const store: StockOutStore = { transaction: async (fn) => fn(tx) };
    const out = createStockOutService(store, () => NOW);
    await out.sell({ idempotencyKey: "sale-key-0001", method: "CASH", /* 🔻 TASK-909: the method is required */ soldAt: "2026-11-05T18:30:00Z", lines: [{ itemId: "11111111-1111-4111-8111-111111111111", qty: 1, unitPriceSatang: 100 }] }, null);
    expect(seen).toEqual([{ occurredOn: "2026-11-06" }]);
  });
});

describe("the routes' gates (no database: they stop before the handler)", () => {
  const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.JWT_SECRET = "test-secret-911";
    process.env.SKIP_ADMIN_AUTH = "false";
  });
  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const app = new Hono().onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code } }, err.status as 400) : c.json({ error: { code: "INTERNAL" } }, 500))).route("/stock", stockRoutes);
  const call = async (method: string, path: string, role: Role | null, body?: unknown) =>
    app.request(`/stock${path}`, { method, headers: { ...(role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ID = "11111111-1111-4111-8111-111111111111";
  const goodProduct = { code: "X", name: "X", category: null, priceSatang: 1, commissionGroup: null, active: true, openingQuantity: 0, revenueCategoryId: SALES_CAT };

  test("product create / edit are CEO ONLY: none 401, coach and admin 403", async () => {
    for (const [m, p, b] of [["POST", "/products", goodProduct], ["PATCH", `/products/${ID}`, { name: "x" }]] as const) {
      expect((await call(m, p, null, b)).status).toBe(401);
      expect((await call(m, p, "coach", b)).status).toBe(403);
      expect((await call(m, p, "admin", b)).status).toBe(403);
    }
  });
  test("Stock IN: none 401, coach 403, and an admin / ceo gets past the gate (an invalid body is a 400, before any database)", async () => {
    const bad = { idempotencyKey: "short", receivedOn: "x", lines: [] };
    expect((await call("POST", "/in", null, bad)).status).toBe(401);
    expect((await call("POST", "/in", "coach", bad)).status).toBe(403);
    expect((await call("POST", "/in", "admin", bad)).status).toBe(400);
    expect((await call("POST", "/in", "ceo", bad)).status).toBe(400);
  });
  test("revenueCategoryId: REQUIRED and a uuid on create (400 when missing / not a uuid); a uuid on edit, never null", async () => {
    const { revenueCategoryId: _d, ...without } = goodProduct;
    expect((await call("POST", "/products", "ceo", without)).status).toBe(400);
    expect((await call("POST", "/products", "ceo", { ...goodProduct, revenueCategoryId: "nope" })).status).toBe(400);
    expect((await call("POST", "/products", "ceo", { ...goodProduct, revenueCategoryId: null })).status).toBe(400);
    expect((await call("PATCH", `/products/${ID}`, "ceo", { revenueCategoryId: null })).status).toBe(400);
    expect((await call("PATCH", `/products/${ID}`, "ceo", { revenueCategoryId: "nope" })).status).toBe(400);
  });
  test("body validation is a 400: product create (negative price, fractional opening, missing field), edit (bad id, bad price), stock-in (qty 0, bad uuid)", async () => {
    expect((await call("POST", "/products", "ceo", { ...goodProduct, priceSatang: -1 })).status).toBe(400);
    expect((await call("POST", "/products", "ceo", { ...goodProduct, openingQuantity: 1.5 })).status).toBe(400);
    expect((await call("POST", "/products", "ceo", { name: "x" })).status).toBe(400);
    expect((await call("PATCH", "/products/not-a-uuid", "ceo", { name: "x" })).status).toBe(400);
    expect((await call("PATCH", `/products/${ID}`, "ceo", { priceSatang: 1.5 })).status).toBe(400);
    const key = "receipt-0001-abc";
    expect((await call("POST", "/in", "ceo", { idempotencyKey: key, receivedOn: "2026-11-09", lines: [{ itemId: ID, qty: 0 }] })).status).toBe(400);
    expect((await call("POST", "/in", "ceo", { idempotencyKey: key, receivedOn: "2026-11-09", lines: [{ itemId: "nope", qty: 1 }] })).status).toBe(400);
  });
});
