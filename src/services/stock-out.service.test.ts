// TASK-909 — Stock OUT, DB-free: a cart → one SALE movement per line + a sale record, atomic, idempotent, NEGATIVE_BALANCE reused from 904, no totals in the response.
// Each test must fail when its line in the code goes (mutation set: stock-out-task909.mutations.json).
import { describe, expect, test } from "bun:test";
import { ApiException } from "../lib/http";
import { refuseIfNegative } from "../lib/stock-import";
import { movementTypeOf } from "../lib/stock-read";
import { createStockOutService, lineNetMinor, type Cart, type LockedItem, type StockOutStore, type StockOutTx } from "./stock-out.service";

const file = async (p: string) => (await Bun.file(new URL(p, import.meta.url)).text()).replace(/\r\n/g, "\n");
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_X = "33333333-3333-4333-8333-333333333333";
const KEY = "cart-0001-abcdef";
const NOW = new Date("2026-11-09T05:00:00.000Z");

interface MemState {
  items: LockedItem[];
  sales: Array<{ id: string; key: string; soldAt: string; branch: string; method: string | null; buyerRef: string | null; remark: string | null; sellerRefs: string[]; actor: string | null }>;
  lines: Array<{ saleId: string; itemId: string; qty: number; unitPriceMinor: number; discountMinor: number; commissionMinor: number; movementId: string }>;
  movements: Array<{ id: string; itemId: string; saleId: string; qty: number; remainingAfter: number; valueMinor: number; key: string; actor: string | null }>;
  calls: string[];
  revenue: Array<{ saleLineId: string; soldOn: string; branch: string; method: string; categoryId: string; productName: string; amountMinor: number; actor: string | null }>;
}
function memory(items: LockedItem[]) {
  const st: MemState = { items: items.map((i) => ({ ...i })), sales: [], lines: [], movements: [], calls: [], revenue: [] };
  let n = 0;
  const store: StockOutStore = {
    transaction: async (fn) => {
      const snap = JSON.stringify({ i: st.items, s: st.sales, l: st.lines, m: st.movements, r: st.revenue });
      try {
        const tx: StockOutTx = {
          lockItems: async (ids) => { st.calls.push("lock"); return st.items.filter((i) => ids.includes(i.id)).map((i) => ({ ...i })); },
          saleByKey: async (key) => { st.calls.push("saleByKey"); const s = st.sales.find((x) => x.key === key); return s ? { id: s.id, soldAt: s.soldAt, lines: st.lines.filter((l) => l.saleId === s.id).length } : null; },
          insertSale: async (s) => { st.calls.push("insertSale"); const id = `sale-${++n}`; st.sales.push({ id, key: s.idempotencyKey, soldAt: s.soldAt.toISOString(), branch: s.branch, method: s.method, buyerRef: s.buyerRef, remark: s.remark, sellerRefs: s.sellerRefs, actor: s.actor }); return id; },
          addSaleMovement: async (m) => { st.calls.push("movement"); const it = st.items.find((i) => i.id === m.itemId)!; it.qty = m.remainingAfter; const id = `mv-${++n}`; st.movements.push({ id, itemId: m.itemId, saleId: m.saleId, qty: m.qty, remainingAfter: m.remainingAfter, valueMinor: m.valueMinor, key: m.idempotencyKey, actor: m.actor }); return id; },
          insertSaleLine: async (l) => { st.calls.push("line"); st.lines.push({ ...l }); return `line-${st.lines.length}`; },
          postLineRevenue: async (r) => { st.calls.push("revenue"); st.revenue.push({ ...r }); return { written: r.amountMinor > 0 }; },
        };
        return await fn(tx);
      } catch (e) {
        const s = JSON.parse(snap);
        st.items = s.i; st.sales = s.s; st.lines = s.l; st.movements = s.m; st.revenue = s.r;
        throw e;
      }
    },
  };
  const real = createStockOutService(store, () => NOW);
  // the payment method is REQUIRED (row 21); most tests are about something else, so the fixture carts get one unless they set the key themselves (an explicit `method: undefined` is kept)
  const svc = { sell: (c: Cart, actor: string | null) => real.sell({ method: "CASH", ...c }, actor) };
  return { st, store, svc };
}
const IT = (id: string, model: string, qty: number | null, o: Partial<LockedItem> = {}): LockedItem => ({ id, model, name: `Name ${model}`, qty, active: true, revenueCategoryId: "rc-sales", ...o });
const cart = (o: Partial<Cart> = {}): Cart => ({ idempotencyKey: KEY, method: "TRANSFER", lines: [{ itemId: ID_A, qty: 2, unitPriceSatang: 10_000 }, { itemId: ID_B, qty: 1, unitPriceSatang: 25_000, discountSatang: 5_000, commissionSatang: 4_000 }], ...o });
const fail = (p: Promise<unknown>) => p.then(() => null as never, (e) => e as ApiException);

describe("sell — a cart decrements each line once and writes a sale record", () => {
  test("one SALE movement per line (−qty, balance decremented), refType SALE / refId = the sale, key stock-out:<sale>:<item>, value 0 (inventory truth only)", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    const r = await svc.sell(cart({ sellerRefs: ["coach-1", "coach-2"], method: "CASH", branch: "OTHER", buyerRef: "Khun X", remark: "r" }), "ceo1");
    expect(r).toEqual({ saleId: "sale-1", movementsWritten: 2, soldAt: NOW.toISOString() });
    expect(st.items.map((i) => i.qty)).toEqual([3, 2]);
    expect(st.movements.map((m) => [m.itemId, m.qty, m.remainingAfter, m.valueMinor, m.key, m.saleId])).toEqual([
      [ID_A, -2, 3, 0, `stock-out:sale-1:${ID_A}`, "sale-1"],
      [ID_B, -1, 2, 0, `stock-out:sale-1:${ID_B}`, "sale-1"],
    ]);
    expect(st.movements.every((m) => m.actor === "ceo1")).toBe(true);
  });
  test("the sale record keeps price / discount / commission AS GIVEN, the sellers, the actor, and links each line to its movement", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    await svc.sell(cart({ sellerRefs: ["coach-1", "coach-2"], method: "CASH", branch: "OTHER", buyerRef: "Khun X", remark: "r" }), "ceo1");
    expect(st.sales[0]).toMatchObject({ key: KEY, branch: "OTHER", method: "CASH", buyerRef: "Khun X", remark: "r", sellerRefs: ["coach-1", "coach-2"], actor: "ceo1" });
    expect(st.lines.map((l) => [l.itemId, l.qty, l.unitPriceMinor, l.discountMinor, l.commissionMinor])).toEqual([[ID_A, 2, 10_000, 0, 0], [ID_B, 1, 25_000, 5_000, 4_000]]);
    expect(st.lines.map((l) => l.movementId)).toEqual(st.movements.map((m) => m.id));
  });
  test("defaults: branch BRAVO, buyer / remark null, no sellers, the method as given; soldAt defaults to now; an explicit soldAt is kept", async () => {
    const a = memory([IT(ID_A, "A", 5)]);
    await a.svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 100 }] }, null);
    expect(a.st.sales[0]).toMatchObject({ branch: "BRAVO", method: "CASH", buyerRef: null, remark: null, sellerRefs: [], actor: null, soldAt: NOW.toISOString() });
    const b = memory([IT(ID_A, "A", 5)]);
    const r = await b.svc.sell({ idempotencyKey: KEY, soldAt: "2026-11-08T03:00:00Z", lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 100 }] }, null);
    expect(r.soldAt).toBe("2026-11-08T03:00:00.000Z");
  });
  test("the sale record's lines sum to the cart's net (Σ qty × unit − discount) while every movement carries 0 money, and commission is stored, never computed", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    await svc.sell(cart(), null);
    expect(st.movements.every((m) => m.valueMinor === 0)).toBe(true); // the money is NOT on the movement (no shadow-post into the legacy P&L)
    expect(st.lines.reduce((s, l) => s + (l.qty * l.unitPriceMinor - l.discountMinor), 0)).toBe(cart().lines.reduce((s, l) => s + lineNetMinor(l), 0)); // …it is in sale_line: 2×10000 + (25000−5000) = 40000
    expect(st.lines.reduce((s, l) => s + (l.qty * l.unitPriceMinor - l.discountMinor), 0)).toBe(40_000);
    expect(lineNetMinor({ itemId: "x", qty: 3, unitPriceSatang: 1000, discountSatang: 500 })).toBe(2500);
    expect(st.lines[1].commissionMinor).toBe(4_000); // exactly what was given
  });
  test("the response has NO totals / commission / revenue — only saleId, movementsWritten, soldAt (and alreadyApplied)", async () => {
    const { svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    const r = await svc.sell(cart(), null);
    expect(Object.keys(r).sort()).toEqual(["movementsWritten", "saleId", "soldAt"]);
    expect(Object.keys(await svc.sell(cart(), null)).sort()).toEqual(["alreadyApplied", "movementsWritten", "saleId", "soldAt"]);
  });
  test("a Stock-OUT movement shows as type SALE in the movement report", () => {
    expect(movementTypeOf({ qty: -2, refType: "SALE" })).toBe("SALE");
  });
  test("selling the last unit leaves 0 (not negative) and is allowed", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 2)]);
    await svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 2, unitPriceSatang: 1 }] }, null);
    expect(st.items[0].qty).toBe(0);
  });
  test("an item with no tracked balance (null) sells from 0 ⇒ refused, not silently negative", async () => {
    const { svc } = memory([IT(ID_A, "A", null)]);
    expect((await fail(svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] }, null))).code).toBe("NEGATIVE_BALANCE");
  });
});

describe("refusals — the WHOLE sale or nothing", () => {
  test("a line that would go below zero ⇒ 409 NEGATIVE_BALANCE {model, name, resultingBalance}; the OTHER line is not decremented; no sale, no movement", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 0)]);
    const err = await fail(svc.sell(cart(), null));
    expect(err).toBeInstanceOf(ApiException);
    expect(err.status).toBe(409);
    expect(err.code).toBe("NEGATIVE_BALANCE");
    expect(err.details).toEqual({ model: "B", name: "Name B", resultingBalance: -1 });
    expect(st.items.map((i) => i.qty)).toEqual([5, 0]);
    expect(st.sales).toEqual([]);
    expect(st.movements).toEqual([]);
    expect(st.lines).toEqual([]);
  });
  test("the SAME rule as the import: refuseIfNegative is the one function (resulting balance, message names the item)", () => {
    expect(refuseIfNegative("M", "Name", 5, -5)).toBe(0);
    expect(() => refuseIfNegative("M", "Name", 5, -6)).toThrow(/«M»/);
    try { refuseIfNegative("M", "Name", 5, -6); } catch (e: any) { expect([e.code, e.model, e.item, e.resultingBalance]).toEqual(["NEGATIVE_BALANCE", "M", "Name", -1]); }
  });
  test("an unknown / non-stock item ⇒ 404 UNKNOWN_ITEM; an inactive one ⇒ 409 ITEM_INACTIVE; nothing written", async () => {
    const m = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 5, { active: false })]);
    const e1 = await fail(m.svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_X, qty: 1, unitPriceSatang: 1 }] }, null));
    expect([e1.status, e1.code]).toEqual([404, "UNKNOWN_ITEM"]);
    const e2 = await fail(m.svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_B, qty: 1, unitPriceSatang: 1 }] }, null));
    expect([e2.status, e2.code]).toEqual([409, "ITEM_INACTIVE"]);
    expect(m.st.movements).toEqual([]);
  });
  test("a malformed cart is a 400 BEFORE anything is locked: duplicate item, qty 0 / 1.5, a discount over the line, a future soldAt, a bad date", async () => {
    const m = memory([IT(ID_A, "A", 5)]);
    const bad: Cart[] = [
      { idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }, { itemId: ID_A, qty: 1, unitPriceSatang: 1 }] },
      { idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 0, unitPriceSatang: 1 }] },
      { idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 1.5, unitPriceSatang: 1 }] },
      { idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 2, unitPriceSatang: 100, discountSatang: 201 }] },
      { idempotencyKey: KEY, soldAt: "2026-12-31T00:00:00Z", lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] },
      { idempotencyKey: KEY, soldAt: "not a date", lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] },
    ];
    for (const c of bad) { const e = await fail(m.svc.sell(c, null)); expect([e.status, e.code]).toEqual([400, "VALIDATION"]); }
    expect(m.st.calls).toEqual([]); // nothing was even locked
    // a discount exactly equal to the line is allowed (a free item)
    await m.svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 2, unitPriceSatang: 100, discountSatang: 200 }] }, null);
    expect(m.st.movements[0].valueMinor).toBe(0);
  });
});

describe("revenue seam (row 21) — the method is required and a product needs a revenue category", () => {
  test("no payment method ⇒ 400 METHOD_REQUIRED, and NOTHING is even locked or written", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5)]);
    const err = await fail(svc.sell({ idempotencyKey: KEY, method: undefined, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] }, null));
    expect([err.status, err.code]).toEqual([400, "METHOD_REQUIRED"]);
    expect(st.calls).toEqual([]);
    expect(st.items[0].qty).toBe(5);
  });
  test("a product with NO revenue category ⇒ 400 NO_REVENUE_CATEGORY naming it; the WHOLE sale refused (the other line is not decremented, no sale)", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 5, { revenueCategoryId: null })]);
    const err = await fail(svc.sell(cart(), null));
    expect([err.status, err.code]).toEqual([400, "NO_REVENUE_CATEGORY"]);
    expect(err.details).toEqual({ itemId: ID_B, model: "B" });
    expect(st.items.map((i) => i.qty)).toEqual([5, 5]);
    expect(st.sales).toEqual([]);
    expect(st.movements).toEqual([]);
  });
  test("the movement value stays 0 (the money is revenue now, never also on the movement)", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5)]);
    await svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 500 }] }, null);
    expect(st.movements[0].valueMinor).toBe(0);
  });
});

describe("the revenue line per sale line (row 21) — posted in the sale's own transaction", () => {
  test("one revenue post per line: the line's id, the sale's Bangkok day / branch / method, the PRODUCT's category and name, amount = line NET (commission never in it), the actor", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5, { revenueCategoryId: "rc-bike" }), IT(ID_B, "B", 3, { revenueCategoryId: "rc-snack" })]);
    await svc.sell(cart({ soldAt: "2026-11-05T18:30:00Z", branch: "OTHER", method: "CARD" }), "ceo1");
    expect(st.revenue).toEqual([
      { saleLineId: "line-1", soldOn: "2026-11-06", branch: "OTHER", method: "CARD", categoryId: "rc-bike", productName: "Name A", amountMinor: 20_000, actor: "ceo1" },
      { saleLineId: "line-2", soldOn: "2026-11-06", branch: "OTHER", method: "CARD", categoryId: "rc-snack", productName: "Name B", amountMinor: 20_000, actor: "ceo1" }, // 25000 − 5000 discount; the 4000 commission is NOT netted
    ]);
  });
  test("the revenue is posted AFTER the line and its movement exist, per line, in order", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    await svc.sell(cart(), null);
    expect(st.calls).toEqual(["lock", "saleByKey", "insertSale", "movement", "line", "revenue", "movement", "line", "revenue"]);
  });
  test("a failed revenue post rolls the WHOLE sale back (no sale, no movement, balances untouched, no revenue left)", async () => {
    const { st, store } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    let n = 0;
    const failing: StockOutStore = { transaction: (fn) => store.transaction(async (tx) => fn({ ...tx, postLineRevenue: async (r) => { if (++n === 2) throw new Error("ledger down"); return tx.postLineRevenue(r); } })) };
    const err = await createStockOutService(failing, () => NOW).sell(cart(), null).catch((e) => e);
    expect(String(err)).toContain("ledger down");
    expect(st.items.map((i) => i.qty)).toEqual([5, 3]);
    expect(st.sales).toEqual([]);
    expect(st.movements).toEqual([]);
    expect(st.revenue).toEqual([]);
  });
  test("a re-POST posts NO new revenue", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    await svc.sell(cart(), null);
    await svc.sell(cart(), null);
    expect(st.revenue).toHaveLength(2);
  });
  test("the store posts through postSaleLineRevenue on the sale's OWN tx; the product form's picker route is ceo + admin", async () => {
    const S = (await file("./stock-out.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(S).toContain("postLineRevenue: (r) => postSaleLineRevenue(tx, r),");
    const R = (await file("../routes/stock.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(R).toContain('.get("/revenue-categories", adminAuth, async (c) => c.json(await listRevenueCategories()))');
    const K = (await file("./stock-read.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(K).toContain('inArray(boRevenueCategory.type, ["SALES", "FNB", "RENT", "OTHER"])');
    expect(K).toContain("eq(boRevenueCategory.active, true)");
  });
});

describe("postSaleLineRevenue — the writer (a recording fake executor)", () => {
  const rec = (cat: any, inserted: any[] = [{ id: "rl-1" }]) => {
    const log: { values?: any; conflict?: any } = {};
    const d: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (cat ? [cat] : []) }) }) }),
      insert: () => ({ values: (v: any) => { log.values = v; return { onConflictDoNothing: (c: any) => { log.conflict = c; return { returning: async () => inserted }; } }; } }),
    };
    return { d, log };
  };
  const IN = { saleLineId: "sl-1", soldOn: "2026-11-09", branch: "BRAVO" as const, method: "CASH" as const, categoryId: "c1", productName: "Helmet", amountMinor: 25_000, actor: "ceo" };
  test("writes the line: type FROM THE CATEGORY, source STOCK, refType SALE_LINE, refId, key rl:sale-line:<id>, the day, branch, method, name, amount, actor — and ON CONFLICT DO NOTHING on the key", async () => {
    const { postSaleLineRevenue } = await import("./sale-line-revenue.service");
    const { d, log } = rec({ id: "c1", type: "FNB", name: "Drink", active: true });
    expect(await postSaleLineRevenue(d, IN)).toEqual({ written: true });
    expect(log.values).toEqual({ occurredOn: "2026-11-09", branch: "BRAVO", type: "FNB", categoryId: "c1", productName: "Helmet", amountMinor: 25_000, method: "CASH", remark: null, source: "STOCK", refType: "SALE_LINE", refId: "sl-1", idempotencyKey: "rl:sale-line:sl-1", actor: "ceo" });
    expect(log.conflict).toBeDefined();
  });
  test("a replay (the key already there ⇒ nothing returned) answers written:false", async () => {
    const { postSaleLineRevenue } = await import("./sale-line-revenue.service");
    expect(await postSaleLineRevenue(rec({ id: "c1", type: "SALES", active: true }, []).d, IN)).toEqual({ written: false });
  });
  test("a net ≤ 0 writes nothing and does not even read the category", async () => {
    const { postSaleLineRevenue } = await import("./sale-line-revenue.service");
    let touched = 0;
    const d: any = { select: () => { touched++; throw new Error("no"); }, insert: () => { touched++; throw new Error("no"); } };
    expect(await postSaleLineRevenue(d, { ...IN, amountMinor: 0 })).toEqual({ written: false });
    expect(await postSaleLineRevenue(d, { ...IN, amountMinor: -5 })).toEqual({ written: false });
    expect(touched).toBe(0);
  });
  test("a missing / inactive category ⇒ 400 NO_REVENUE_CATEGORY and nothing inserted", async () => {
    const { postSaleLineRevenue } = await import("./sale-line-revenue.service");
    for (const cat of [null, { id: "c1", type: "SALES", active: false }]) {
      const { d, log } = rec(cat);
      const err = await postSaleLineRevenue(d, IN).catch((e) => e);
      expect(err).toBeInstanceOf(ApiException);
      expect([err.status, err.code]).toEqual([400, "NO_REVENUE_CATEGORY"]);
      expect(log.values).toBeUndefined();
    }
  });
  test("any other DB error PROPAGATES (it is the sale's rollback)", async () => {
    const { postSaleLineRevenue } = await import("./sale-line-revenue.service");
    const d: any = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "c1", type: "SALES", active: true }] }) }) }), insert: () => { throw new Error("db boom"); } };
    expect(String(await postSaleLineRevenue(d, IN).catch((e) => e))).toContain("db boom");
  });
});

describe("idempotency — one confirmed cart, one write", () => {
  test("re-POST of the same key writes nothing and returns the FIRST result with alreadyApplied", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    const first = await svc.sell(cart(), "ceo1");
    const snap = JSON.stringify(st);
    const again = await svc.sell(cart(), "ceo1");
    expect(again).toEqual({ ...first, alreadyApplied: true });
    expect(JSON.stringify(st.items)).toBe(JSON.stringify(snap ? JSON.parse(snap).items : []));
    expect(st.sales).toHaveLength(1);
    expect(st.movements).toHaveLength(2);
    expect(st.items.map((i) => i.qty)).toEqual([3, 2]); // decremented ONCE
  });
  test("the items are locked BEFORE the key is looked up, and a retry never reaches the writes", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5)]);
    await svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] }, null);
    expect(st.calls).toEqual(["lock", "saleByKey", "insertSale", "movement", "line", "revenue"]);
    st.calls.length = 0;
    await svc.sell({ idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] }, null);
    expect(st.calls).toEqual(["lock", "saleByKey"]);
  });
  test("a different key is a different sale", async () => {
    const { st, svc } = memory([IT(ID_A, "A", 5)]);
    await svc.sell({ idempotencyKey: "key-aaaaaaaa", lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] }, null);
    await svc.sell({ idempotencyKey: "key-bbbbbbbb", lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] }, null);
    expect(st.sales).toHaveLength(2);
    expect(st.items[0].qty).toBe(3);
  });
  test("two posts racing past the check: the unique index (23505) decides and the loser answers with the winner's result", async () => {
    const { store, st } = memory([IT(ID_A, "A", 5)]);
    let first = true;
    const racing: StockOutStore = {
      transaction: (fn) => store.transaction(async (tx) => fn({ ...tx, insertSale: async (s) => {
        if (first) { first = false; st.sales.push({ id: "winner", key: s.idempotencyKey, soldAt: NOW.toISOString(), branch: "BRAVO", method: null, buyerRef: null, remark: null, sellerRefs: [], actor: null }); st.lines.push({ saleId: "winner", itemId: ID_A, qty: 1, unitPriceMinor: 1, discountMinor: 0, commissionMinor: 0, movementId: "m" }); const e: any = new Error("dup"); e.code = "23505"; throw e; }
        return tx.insertSale(s);
      } })),
    };
    // the failed first transaction rolls back its own writes but the «winner» row is another connection's — re-add it after the rollback
    const svc = createStockOutService({ transaction: async (fn) => { try { return await racing.transaction(fn); } finally { if (!st.sales.some((s) => s.id === "winner")) { st.sales.push({ id: "winner", key: KEY, soldAt: NOW.toISOString(), branch: "BRAVO", method: null, buyerRef: null, remark: null, sellerRefs: [], actor: null }); st.lines.push({ saleId: "winner", itemId: ID_A, qty: 1, unitPriceMinor: 1, discountMinor: 0, commissionMinor: 0, movementId: "m" }); } } } }, () => NOW);
    const r = await svc.sell({ idempotencyKey: KEY, method: "CASH", lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1 }] }, null);
    expect(r).toMatchObject({ saleId: "winner", alreadyApplied: true, movementsWritten: 1 });
  });
  test("an apply that fails half-way leaves nothing behind (atomic)", async () => {
    const { st, store } = memory([IT(ID_A, "A", 5), IT(ID_B, "B", 3)]);
    let moves = 0;
    const failing: StockOutStore = { transaction: (fn) => store.transaction(async (tx) => fn({ ...tx, addSaleMovement: async (m) => { if (++moves === 2) throw new Error("boom"); return tx.addSaleMovement(m); } })) };
    const err = await createStockOutService(failing, () => NOW).sell(cart(), null).catch((e) => e);
    expect(String(err)).toContain("boom");
    expect(st.items.map((i) => i.qty)).toEqual([5, 3]);
    expect(st.sales).toEqual([]);
    expect(st.movements).toEqual([]);
  });
});

describe("the route and the schema — pins", () => {
  test("POST /stock/out is ceo + admin (adminAuth); a NEGATIVE_BALANCE falls through to the app's onError envelope, same as the import", async () => {
    const R = (await file("../routes/stock.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(R).toContain('.post("/out", adminAuth, zValidator("json", stockOutBody),');
    expect(R).not.toContain("negativeBalanceBody");
    expect(R).toContain("stockOutService.sell(c.req.valid(\"json\"), user?.sub ?? null)");
  });
  test("the body: a key, 1–200 integer lines, money ≥ 0 integers, uuid items; extra keys (totals) are stripped, never read", async () => {
    const { stockOutBody } = await import("../routes/stock");
    const ok = { idempotencyKey: KEY, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 100 }] };
    expect(stockOutBody.safeParse(ok).success).toBe(true);
    const bad: unknown[] = [
      {}, { ...ok, idempotencyKey: "short" }, { ...ok, idempotencyKey: "has space in it!" }, { ...ok, lines: [] },
      { ...ok, lines: [{ itemId: "nope", qty: 1, unitPriceSatang: 1 }] }, { ...ok, lines: [{ itemId: ID_A, qty: 0, unitPriceSatang: 1 }] },
      { ...ok, lines: [{ itemId: ID_A, qty: 1.5, unitPriceSatang: 1 }] }, { ...ok, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: -1 }] },
      { ...ok, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1.5 }] }, { ...ok, lines: [{ itemId: ID_A, qty: 1, unitPriceSatang: 1, commissionSatang: -5 }] },
      { ...ok, lines: Array.from({ length: 201 }, () => ({ itemId: ID_A, qty: 1, unitPriceSatang: 1 })) }, { ...ok, method: "BITCOIN" }, { ...ok, branch: "MAIN" }, { ...ok, soldAt: "xx" },
      { ...ok, sellerRefs: Array.from({ length: 21 }, (_, i) => `s${i}`) },
    ];
    for (const b of bad) expect(stockOutBody.safeParse(b).success).toBe(false);
    expect(Object.keys(stockOutBody.parse({ ...ok, totalSatang: 9, commissionTotal: 1 })).sort()).toEqual(["idempotencyKey", "lines"]);
  });
  test("the service does no commission math and reuses 904's rule", async () => {
    const S = (await file("./stock-out.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(S).toContain("refuseIfNegative(it.model, it.name, it.qty ?? 0, -l.qty)");
    expect(S).not.toMatch(/commission[A-Za-z]*\s*[*/+]|rate|pool|split/i); // stored as given, never computed
    expect(S).toContain('.orderBy(asc(boItem.id)).for("update")'); // locked, in id order
    expect(S).toContain('refType: "SALE"');
    expect(S).toContain('refType: "SALE", refId: m.saleId, idempotencyKey: m.idempotencyKey, actor: m.actor'); // the movement points at its sale
    expect(S).toContain("where(and(eq(boItem.externalSource, STOCK_SOURCE), inArray(boItem.id, ids)))"); // only stock products can be sold
    expect(S).toContain("`stock-out:${saleId}:${it.id}`");
    const I = (await file("../lib/stock-import.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(I).toContain("refuseIfNegative(e.model, p.name, p.qty ?? 0, e.delta);"); // the import uses the same function
  });
  test("migration 0016: two NEW tables, additive, journaled, witnessed by the LAST object", async () => {
    const M = (await file("../../drizzle/0016_bo_sale.sql")).replace(/^--.*$/gm, "");
    expect(M).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|UPDATE |INSERT /);
    expect(M.match(/CREATE TABLE/g)?.length).toBe(2);
    expect(M.trimEnd().split("\n").pop()).toContain('"bo_sale_line_movement_uq"');
    expect(M).toContain('"idempotency_key" text NOT NULL');
    expect(M).toContain('CREATE UNIQUE INDEX "bo_sale_idempotency_uq" ON "bo"."sale" ("idempotency_key");');
    expect(M).toContain('"discount_minor" <= "qty" * "unit_price_minor"');
    expect(M).toContain("\"branch\" IN ('BRAVO','OTHER')");
    expect(await file("../../drizzle/meta/_journal.json")).toContain('"tag": "0016_bo_sale"');
    const W = await file("../lib/migration-witness.ts");
    expect(W).toContain('tag: "0016_bo_sale"');
    expect(W).toContain('index: "bo_sale_line_movement_uq"');
    const sc = await file("../db/schema.ts");
    expect(sc).toContain('export const boSale = bo.table(');
    expect(sc).toContain('export const boSaleLine = bo.table(');
  });
});
