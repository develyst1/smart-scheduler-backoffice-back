// TASK-904 — the Stock git-style import, DB-free: the sheet parser, the four diff kinds, the apply (movements / field edits / new products), idempotency,
// the negative-balance refusal, "nothing is ever deleted", the .xlsx reader on a REAL generated workbook, the reads' pure bits, and the route/auth/migration pins.
// Each test must fail when its line in the code goes (mutation set: stock-import-task904.mutations.json).
import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { ApiException } from "../lib/http";
import {
  STOCK_SOURCE, batchOf, computeDiff, matchRevenueCategory, movementKey, parseStockSheet, planApply, satangFromBaht, wholeQty,
  type DiffEntry, type RevenueCat, type StockProduct,
} from "../lib/stock-import";
import { MOVEMENT_TYPES, bangkokDayBounds, daysBetween, escapeLike, movementTypeOf } from "../lib/stock-read";
import { createStaging, createStockImportService, readStockGrid, type NewProduct, type ProductPatch, type StockStore, type StockTx } from "./stock-import.service";

const file = async (p: string) => (await Bun.file(new URL(p, import.meta.url)).text()).replace(/\r\n/g, "\n");

// ── the customer's shape: a two-row header, «Balance» over «Bravo / Other»
const HEAD = [[null, "Model Code", "Name", "Type", "Balance", "Balance", "Remark"], [null, "Model Code", "Name", "Type", "Bravo", "Other", "Remark"]];
const sheet = (...rows: unknown[][]) => [...HEAD, ...rows.map((r) => [null, ...r])];
const P = (o: Partial<StockProduct> & { model: string }): StockProduct => ({ id: `id-${o.model}`, name: `Name ${o.model}`, priceMinor: 0, qty: 0, category: null, commissionGroup: null, note: null, active: true, ...o });

// ── a memory store whose transaction commits only if the callback returns (a throw rolls everything back)
function memoryStore(initial: StockProduct[], cats?: RevenueCat[]) {
  const state = { products: initial.map((p) => ({ ...p })), movements: [] as Array<{ id: string; qty: number; remainingAfter: number; key: string; reason: string; batch: string }>, deleted: 0, cats: (cats ?? []).map((c) => ({ ...c })), defaultsCreated: 0 };
  const store: StockStore = {
    products: async () => state.products.map((p) => ({ ...p })),
    ...(cats ? { revenueCategories: async () => state.cats.map((c) => ({ ...c })) } : {}), // 🔻 TASK-909: the revenue categories exist only when the test gives some
    transaction: async (fn) => {
      const snap = JSON.stringify({ p: state.products, m: state.movements, c: state.cats });
      try {
        const tx: StockTx = {
          products: async () => state.products.map((p) => ({ ...p })),
          ...(cats
            ? {
                revenueCategories: async () => state.cats.map((c) => ({ ...c })),
                ensureDefaultRevenueCategory: async () => {
                  const have = state.cats.find((c) => c.type === "SALES" && c.name.toLowerCase() === "product sales");
                  if (have) return have.id;
                  state.defaultsCreated++;
                  const id = `rc-default-${state.defaultsCreated}`;
                  state.cats.push({ id, type: "SALES", name: "Product sales" });
                  return id;
                },
              }
            : {}),
          batchApplied: async (batch) => state.movements.some((m) => m.key.startsWith(`stock-import:${batch}:`)),
          createProduct: async (n: NewProduct) => {
            const id = `new-${n.model}`;
            state.products.push({ id, model: n.model, name: n.name, priceMinor: n.priceMinor ?? 0, qty: 0, category: n.category, commissionGroup: n.commissionGroup, note: n.note, active: true, revenueCategoryId: n.revenueCategoryId ?? null });
            return id;
          },
          updateProduct: async (id: string, patch: ProductPatch) => {
            const p = state.products.find((x) => x.id === id)!;
            if (patch.name !== undefined) p.name = patch.name;
            if (patch.priceMinor !== undefined) p.priceMinor = patch.priceMinor;
            if (patch.category !== undefined) p.category = patch.category;
            if (patch.commissionGroup !== undefined) p.commissionGroup = patch.commissionGroup;
            if (patch.note !== undefined) p.note = patch.note;
            if (patch.revenueCategoryId !== undefined) p.revenueCategoryId = patch.revenueCategoryId;
          },
          addMovement: async (id, m) => {
            const p = state.products.find((x) => x.id === id)!;
            p.qty = m.remainingAfter;
            state.movements.push({ id, qty: m.qty, remainingAfter: m.remainingAfter, key: m.idempotencyKey, reason: m.reason, batch: m.batch });
          },
        };
        return await fn(tx);
      } catch (e) {
        const s = JSON.parse(snap);
        state.products = s.p; state.movements = s.m; state.cats = s.c;
        throw e;
      }
    },
  };
  return { store, state, svc: createStockImportService(store) };
}

describe("parseStockSheet — the customer's two-row header and every bad cell", () => {
  test("reads Model Code / Name / Type / Bravo / Remark; «Other» is NOT imported and says so", () => {
    const s = parseStockSheet(sheet(["C/BPD01", "Butt PAD", "Skate", 3, 9, "ok"]));
    expect(s.errors).toEqual([]);
    expect(s.rows).toEqual([{ row: 3, model: "C/BPD01", name: "Butt PAD", category: "Skate", priceMinor: undefined, commissionGroup: undefined, note: "ok", qty: 3, other: "9" }]);
    expect(s.notImported).toContain("Other (future branches)");
  });
  test("a NON-ZERO «Other» value is flagged per row (never silently dropped); blank / 0 are not", () => {
    const s = parseStockSheet(sheet(["A", "n", "T", 5, 7, null], ["B", "n", "T", 1, 0, null], ["C", "n", "T", 1, null, null], ["D", "n", "T", 1, "x", null]));
    expect(s.rows.map((r) => r.other)).toEqual(["7", null, null, "x"]);
    const d = computeDiff(s, [P({ model: "A", name: "n", qty: 5, category: "T" })]);
    expect(d.flags).toEqual([
      { model: "A", row: 3, message: "Other branch not supported yet — value 7 not imported" },
      { model: "D", row: 6, message: "Other branch not supported yet — value x not imported" },
    ]);
    expect(d.entries.find((e) => e.model === "A")).toBeUndefined(); // the flag does not change the diff: A's Bravo balance is unchanged
    expect(d.batch).toBe(computeDiff(parseStockSheet(sheet(["A", "n", "T", 5, null, null], ["B", "n", "T", 1, 0, null], ["C", "n", "T", 1, null, null], ["D", "n", "T", 1, null, null])), [P({ model: "A", name: "n", qty: 5, category: "T" })]).batch); // flags are not part of what is confirmed
    expect(computeDiff(parseStockSheet(sheet(["A", "n", "T", 5, 0, null])), []).flags).toEqual([]);
  });
  test("the Bravo balance is read, never the Other one", () => {
    expect(parseStockSheet(sheet(["A", "n", "T", 5, 77, null])).rows[0].qty).toBe(5);
  });
  test("a single-row header with «Balance» works too", () => {
    const s = parseStockSheet([["Model Code", "Name", "Balance"], ["A", "n", 4]]);
    expect(s.rows[0].qty).toBe(4);
  });
  test("price / commission columns are read when present (baht → satang from the digits)", () => {
    const s = parseStockSheet([["Model Code", "Name", "Price", "Commission Group", "Balance"], ["A", "n", "1,250.50", "G1", 2]]);
    expect(s.rows[0]).toMatchObject({ priceMinor: 125050, commissionGroup: "G1", qty: 2 });
  });
  test("a blank balance means «leave it» (qty null); a column that is absent leaves the field undefined", () => {
    const s = parseStockSheet(sheet(["A", "n", "T", null, null, null]));
    expect(s.rows[0].qty).toBeNull();
    expect(s.rows[0].priceMinor).toBeUndefined();
  });
  test("a trailing category list (Type only) is ignored and reported — but a row with a name/balance and no code is still refused", () => {
    const s = parseStockSheet(sheet(["A", "n", "T", 1, null, null], ["", "", "INLINE PRODUCT", "", null, null], ["", "", "F&B", "", null, null]));
    expect(s.errors).toEqual([]);
    expect(s.rows).toHaveLength(1);
    expect(s.notImported).toContain("2 row(s) with only a Type (no code, no name) — ignored");
    expect(parseStockSheet(sheet(["", "n", "T", 1, null, null])).errors).toHaveLength(1);
    expect(parseStockSheet(sheet(["", "", "T", 4, null, null])).errors).toHaveLength(1); // a balance with no code
  });
  test("no «Model Code» header ⇒ an error, no rows", () => {
    const s = parseStockSheet([["a", "b"], [1, 2]]);
    expect(s.rows).toEqual([]);
    expect(s.errors[0].column).toBe("header");
  });
  test("every bad cell is collected with its row: empty code, empty name, duplicate code, bad qty, bad price", () => {
    const s = parseStockSheet([["Model Code", "Name", "Price", "Balance"], ["", "x", "", 1], ["A", "", "", 1], ["B", "n", "", 1], ["b", "n", "", 1], ["C", "n", "", -2], ["D", "n", "", 1.5], ["E", "n", "12.505", 1], ["F", "n", "abc", 1]]);
    const msg = s.errors.map((e) => `${e.row}:${e.column}`);
    expect(msg).toEqual(expect.arrayContaining(["2:Model Code", "3:Name", "5:Model Code", "6:Balance (Bravo)", "7:Balance (Bravo)", "8:Price", "9:Price"]));
    expect(s.errors.find((e) => e.row === 5)!.message).toContain("แถว 4");
  });
  test("blank lines are skipped; over-long text is refused; a huge sheet is refused", () => {
    expect(parseStockSheet(sheet(["A", "n", "T", 1, null, null], [null, null, null, null, null, null], ["B", "n", "T", 2, null, null])).rows).toHaveLength(2);
    expect(parseStockSheet(sheet(["A".repeat(65), "n", "T", 1, null, null])).errors.length).toBeGreaterThan(0);
    const big = [["Model Code", "Name"], ...Array.from({ length: 5001 }, (_, i) => [`C${i}`, "n"])];
    expect(parseStockSheet(big).errors[0].column).toBe("sheet");
  });
  test("satangFromBaht / wholeQty — digits only, no float", () => {
    expect(satangFromBaht("12")).toBe(1200);
    expect(satangFromBaht("12.5")).toBe(1250);
    expect(satangFromBaht(0.29)).toBe(29); // 0.29 × 100 would be 28.999… in a float
    expect(satangFromBaht(1.15)).toBe(115);
    expect(satangFromBaht("-1")).toBeNull();
    expect(satangFromBaht("1e3")).toBeNull();
    expect(wholeQty("3.0")).toBe(3);
    expect(wholeQty(3)).toBe(3);
    expect(wholeQty("-1")).toBeNull();
    expect(wholeQty("1.5")).toBeNull();
    expect(wholeQty("x")).toBeNull();
  });
});

describe("computeDiff — the four kinds", () => {
  const current = [P({ model: "A", name: "Alpha", qty: 5, priceMinor: 1000 }), P({ model: "B", name: "Beta", qty: 2 }), P({ model: "GONE", name: "Gone", qty: 7 }), P({ model: "SAME", name: "Same", qty: 1 })];
  const s = parseStockSheet([["Model Code", "Name", "Price", "Type", "Balance"], ["A", "Alpha", "10", "Skate", 9], ["B", "Beta 2", "", "", 2], ["NEW", "Fresh", "5.50", "Bike", 4], ["SAME", "Same", "", "", 1]]);
  const d = computeDiff(s, current);
  const by = (m: string) => d.entries.find((e) => e.model === m)!;
  test("qty_change: signed delta, before/after", () => {
    expect(by("A")).toMatchObject({ kind: "qty_change", delta: 4, before: { qty: 5 }, after: { qty: 9 } });
  });
  test("field_change: a name edit is NOT a movement (delta 0)", () => {
    expect(by("B")).toMatchObject({ kind: "field_change", delta: 0 });
    expect(by("B").fields).toEqual([{ field: "name", before: "Beta", after: "Beta 2" }]);
  });
  test("new: the opening balance is the delta; every field the sheet sets is listed", () => {
    expect(by("NEW")).toMatchObject({ kind: "new", itemId: null, delta: 4, before: null, after: { qty: 4 } });
    expect(by("NEW").fields.map((f) => f.field).sort()).toEqual(["category", "name", "priceMinor"]);
    expect(by("NEW").fields.find((f) => f.field === "priceMinor")!.after).toBe(550);
  });
  test("removed: shown with its balance, never acted (delta 0)", () => {
    expect(by("GONE")).toMatchObject({ kind: "removed", delta: 0, before: { qty: 7 }, after: null });
  });
  test("an unchanged row is counted, not listed", () => {
    expect(d.entries.find((e) => e.model === "SAME")).toBeUndefined();
    expect(d.unchanged).toBe(1);
  });
  test("a qty AND a price change in one row ⇒ kind qty_change carrying both", () => {
    expect(by("A").fields).toEqual([{ field: "category", before: null, after: "Skate" }]); // price 10 baht = 1000 satang ⇒ unchanged, only the category differs
    const d2 = computeDiff(parseStockSheet([["Model Code", "Name", "Price", "Balance"], ["A", "Alpha", "11", 6]]), current);
    expect(d2.entries.find((e) => e.model === "A")).toMatchObject({ kind: "qty_change", delta: 1 });
    expect(d2.entries.find((e) => e.model === "A")!.fields).toEqual([{ field: "priceMinor", before: 1000, after: 1100 }]);
  });
  test("a blank balance leaves the balance alone; matching is by Model code, case-insensitive", () => {
    const d3 = computeDiff(parseStockSheet([["Model Code", "Name", "Balance"], ["a", "Alpha", ""]]), [P({ model: "A", name: "Alpha", qty: 5 })]);
    expect(d3.entries).toEqual([]);
  });
  test("a product with no tracked balance (null) opens from 0", () => {
    const d4 = computeDiff(parseStockSheet([["Model Code", "Name", "Balance"], ["A", "Alpha", 3]]), [P({ model: "A", name: "Alpha", qty: null })]);
    expect(d4.entries[0]).toMatchObject({ kind: "qty_change", delta: 3, before: { qty: null }, after: { qty: 3 } });
  });
  test("the batch is stable: same entries in any order ⇒ same id; any change ⇒ another", () => {
    expect(batchOf([...d.entries].reverse())).toBe(d.batch);
    const other = d.entries.map((e) => (e.model === "A" ? { ...e, delta: 5 } : e));
    expect(batchOf(other)).not.toBe(d.batch);
    expect(d.batch).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("apply { batchId } — movements, field edits, a new product, idempotency, refusals, never a delete", () => {
  const start = () => [P({ model: "A", name: "Alpha", qty: 5, priceMinor: 1000 }), P({ model: "B", name: "Beta", qty: 2 }), P({ model: "GONE", name: "Gone", qty: 7 })];
  const grid = [["Model Code", "Name", "Price", "Type", "Remark", "Balance"], ["A", "Alpha", "10", "", "", 9], ["B", "Beta 2", "", "", "", 2], ["NEW", "Fresh", "5.50", "Bike", "n1", 4]];
  const fail = async (p: Promise<unknown>) => p.then(() => null as never, (e) => e as ApiException);

  test("the preview STAGES the diff under its batchId; apply takes the batchId ONLY", async () => {
    const { svc } = memoryStore(start());
    const d = await svc.previewGrid(grid);
    expect(d.batchId).toMatch(/^[0-9a-f]{32}$/);
    expect(svc.staged(d.batchId)!.map((e) => e.model).sort()).toEqual(["A", "B", "GONE", "NEW"]);
    expect(svc.apply.length).toBe(1);
  });
  test("writes ONE movement per qty delta (signed), the field edits, a new product with ONE opening movement; the removed row is untouched", async () => {
    const { svc, state } = memoryStore(start());
    const d = await svc.previewGrid(grid);
    const r = await svc.apply(d.batchId);
    expect(r).toEqual({ batchId: d.batchId, movementsWritten: 2, itemsAdded: 1, fieldEdits: 1, removedLeft: 1 });
    const get = (m: string) => state.products.find((p) => p.model === m)!;
    expect(get("A").qty).toBe(9);
    expect(get("B").name).toBe("Beta 2");
    expect(get("B").qty).toBe(2);
    expect(get("NEW")).toMatchObject({ name: "Fresh", priceMinor: 550, category: "Bike", note: "n1", qty: 4 });
    expect(get("GONE")).toMatchObject({ qty: 7, name: "Gone" });
    expect(state.movements.map((m) => [m.qty, m.remainingAfter]).sort()).toEqual([[4, 4], [4, 9]]);
    expect(state.movements.every((m) => m.key.startsWith(`stock-import:${d.batchId}:`))).toBe(true);
    expect(state.movements.find((m) => m.qty === 4 && m.remainingAfter === 4)!.reason).toContain("Opening balance");
  });
  test("a name/price change alone writes NO movement", async () => {
    const { svc, state } = memoryStore(start());
    const d = await svc.previewGrid([["Model Code", "Name", "Balance"], ["B", "Beta 3", 2]]);
    const r = await svc.apply(d.batchId);
    expect(r.movementsWritten).toBe(0);
    expect(r.fieldEdits).toBe(1);
    expect(state.movements).toEqual([]);
    expect(state.products.find((p) => p.model === "B")!.name).toBe("Beta 3");
  });
  test("a new product with balance 0 is created and writes no movement", async () => {
    const { svc, state } = memoryStore([]);
    const r = await svc.apply((await svc.previewGrid([["Model Code", "Name", "Balance"], ["Z", "Zed", 0]])).batchId);
    expect(r.itemsAdded).toBe(1);
    expect(r.movementsWritten).toBe(0);
    expect(state.movements).toEqual([]);
  });
  test("RE-APPLY of the same batch writes nothing more and says alreadyApplied", async () => {
    const { svc, state } = memoryStore(start());
    const d = await svc.previewGrid(grid);
    await svc.apply(d.batchId);
    const snap = JSON.stringify(state);
    const again = await svc.apply(d.batchId);
    expect(again.alreadyApplied).toBe(true);
    expect(again.movementsWritten).toBe(0);
    expect(JSON.stringify(state)).toBe(snap);
    expect(JSON.stringify(await svc.apply(d.batchId))).toBe(JSON.stringify(again));
  });
  test("a balance sold down since the preview that would now go NEGATIVE ⇒ 409 NEGATIVE_BALANCE {model, name, resultingBalance}; nothing written", async () => {
    const { svc, state } = memoryStore(start());
    const d = await svc.previewGrid([["Model Code", "Name", "Balance"], ["A", "Alpha", 2], ["B", "Beta", 2]]); // A: 5 → 2 = −3
    state.products.find((p) => p.model === "A")!.qty = 1; // 4 sold meanwhile
    const snap = JSON.stringify(state);
    const err = await fail(svc.apply(d.batchId));
    expect(err).toBeInstanceOf(ApiException);
    expect(err.status).toBe(409);
    expect(err.code).toBe("NEGATIVE_BALANCE");
    expect(err.details).toEqual({ model: "A", name: "Alpha", resultingBalance: -2 });
    expect(JSON.stringify(state)).toBe(snap);
  });
  test("a stale preview that would NOT go negative ⇒ 409 STALE, nothing written", async () => {
    const { svc, state } = memoryStore(start());
    const d = await svc.previewGrid(grid);
    state.products.find((p) => p.model === "A")!.qty = 6;
    const snap = JSON.stringify(state);
    const err = await fail(svc.apply(d.batchId));
    expect(err).toBeInstanceOf(ApiException);
    expect(err.status).toBe(409);
    expect(err.code).toBe("STALE");
    expect(JSON.stringify(state)).toBe(snap);
  });
  test("a `new` whose code appeared meanwhile ⇒ STALE; an item that vanished ⇒ STALE", async () => {
    const m1 = memoryStore([]);
    const d1 = await m1.svc.previewGrid([["Model Code", "Name", "Balance"], ["NEW", "x", 1]]);
    m1.state.products.push(P({ model: "NEW", qty: 1 }));
    expect((await fail(m1.svc.apply(d1.batchId))).code).toBe("STALE");
    const m2 = memoryStore([P({ model: "Q", name: "Q", qty: 1 })]);
    const d2 = await m2.svc.previewGrid([["Model Code", "Name", "Balance"], ["Q", "Q", 3]]);
    m2.state.products = [];
    expect((await fail(m2.svc.apply(d2.batchId))).code).toBe("STALE");
  });
  test("planApply refuses a duplicate model with BAD_DIFF, and a TAMPERED removed entry (delta + field edits) plans nothing", () => {
    const e: DiffEntry = { model: "A", kind: "qty_change", itemId: "id-A", name: "x", before: { qty: 5 }, after: { qty: 6 }, delta: 1, fields: [] };
    expect(() => planApply([e, e], [P({ model: "A", qty: 5 })])).toThrow(/ซ้ำ/);
    const r: DiffEntry = { model: "GONE", kind: "removed", itemId: "id-GONE", name: "hack", before: { qty: 999 }, after: null, delta: 5, fields: [{ field: "name", before: "Gone", after: "hack" }] };
    expect(planApply([r], [P({ model: "GONE", qty: 7 })]).movements).toEqual([]);
  });
  test("a batch with only removed entries does nothing, ever — the products and their balances stay", async () => {
    const { svc, state } = memoryStore(start());
    const d = await svc.previewGrid([["Model Code", "Name", "Balance"], ["A", "Alpha", 5]]);
    expect(d.rows.map((r) => r.kind)).toEqual(["removed", "removed"]);
    const r = await svc.apply(d.batchId);
    expect(r).toEqual({ batchId: d.batchId, movementsWritten: 0, itemsAdded: 0, fieldEdits: 0, removedLeft: 2 });
    expect(state.products).toHaveLength(3);
    expect(state.deleted).toBe(0);
  });
  test("an apply that fails half-way leaves nothing behind (atomic)", async () => {
    const { svc, state, store } = memoryStore(start());
    const d = await svc.previewGrid(grid);
    const snap = JSON.stringify(state);
    const orig = store.transaction;
    const failing: StockStore = { products: store.products, transaction: (fn) => orig((tx) => fn({ ...tx, addMovement: async (id, m) => { if (m.qty === 4 && m.remainingAfter === 9) throw new Error("boom"); return tx.addMovement(id, m); } })) };
    const f = createStockImportService(failing);
    const d2 = await f.previewGrid(grid);
    expect(d2.batchId).toBe(d.batchId);
    const err = await f.apply(d2.batchId).catch((x) => x);
    expect(String(err)).toContain("boom");
    expect(JSON.stringify(state)).toBe(snap);
  });
  test("the movement key is stock-import:<batch>:<model>", () => {
    expect(movementKey("abc", "C/X")).toBe("stock-import:abc:C/X");
    const { movements, batch } = planApply([{ model: "A", kind: "qty_change", itemId: "id-A", name: "A", before: { qty: 5 }, after: { qty: 6 }, delta: 1, fields: [] }], [P({ model: "A", qty: 5 })]);
    expect(movements[0].idempotencyKey).toBe(`stock-import:${batch}:A`);
  });
});

describe("the revenue category (row 21) — the sheet's Type maps to one, the rest fall into SALES / «Product sales», flagged", () => {
  const CATS: RevenueCat[] = [
    { id: "rc-miller", type: "SALES", name: "Miller" }, { id: "rc-bike", type: "SALES", name: "Bike" }, { id: "rc-snack", type: "FNB", name: "Snack" },
    { id: "rc-private", type: "COURSE", name: "Bike" }, // a COURSE category with a product name — never a product's category
  ];
  const G = (...rows: unknown[][]) => [["Model Code", "Name", "Type", "Balance"], ...rows];

  test("matchRevenueCategory: by name, case-insensitive, product types only; none / ambiguous ⇒ null", () => {
    expect(matchRevenueCategory("bike", CATS)?.id).toBe("rc-bike"); // the COURSE «Bike» is ignored, so it is not ambiguous
    expect(matchRevenueCategory("  MILLER ", CATS)?.id).toBe("rc-miller");
    expect(matchRevenueCategory("Snack", CATS)?.id).toBe("rc-snack");
    expect(matchRevenueCategory("Skate", CATS)).toBeNull();
    expect(matchRevenueCategory("", CATS)).toBeNull();
    expect(matchRevenueCategory(null, CATS)).toBeNull();
    expect(matchRevenueCategory("X", [{ id: "1", type: "SALES", name: "X" }, { id: "2", type: "FNB", name: "x" }])).toBeNull(); // the same name under two product types
  });
  test("a new product with a matching Type gets THAT category; an unmatched one gets the default, created ONCE", async () => {
    const { svc, state } = memoryStore([], CATS);
    const d = await svc.previewGrid(G(["A", "a", "Bike", 1], ["B", "b", "Skate", 1], ["C", "c", "", 1], ["D", "d", "Skate", 0]));
    await svc.apply(d.batchId);
    const rc = Object.fromEntries(state.products.map((p) => [p.model, p.revenueCategoryId]));
    expect(rc.A).toBe("rc-bike");
    expect(rc.B).toBe("rc-default-1");
    expect(rc.C).toBe("rc-default-1");
    expect(rc.D).toBe("rc-default-1");
    expect(state.defaultsCreated).toBe(1);
    expect(state.cats.filter((c) => c.name === "Product sales")).toHaveLength(1);
  });
  test("an existing «Product sales» is reused (any case), not duplicated", async () => {
    const { svc, state } = memoryStore([], [...CATS, { id: "rc-ps", type: "SALES", name: "PRODUCT SALES" }]);
    await svc.apply((await svc.previewGrid(G(["B", "b", "Skate", 1]))).batchId);
    expect(state.products[0].revenueCategoryId).toBe("rc-ps");
    expect(state.defaultsCreated).toBe(0);
  });
  test("the preview FLAGS every written product the sheet cannot place — and only those", async () => {
    const { svc } = memoryStore([], CATS);
    const d = await svc.previewGrid(G(["A", "a", "Bike", 1], ["B", "b", "Skate", 1], ["C", "c", "", 1]));
    expect(d.flags.map((f) => [f.model, f.message])).toEqual([
      ["B", "No revenue category matches «Skate» — will use SALES / Product sales"],
      ["C", "No revenue category matches «(no Type)» — will use SALES / Product sales"],
    ]);
  });
  test("an existing product with NO revenue category gets one the day it is touched; one that has one keeps it; an untouched row writes nothing", async () => {
    const start = [P({ model: "OLD", name: "Old", qty: 1, category: "Bike" }), P({ model: "HAS", name: "Has", qty: 1, revenueCategoryId: "rc-miller" }), P({ model: "QUIET", name: "Quiet", qty: 1, category: "Bike" })];
    const { svc, state } = memoryStore(start, CATS);
    const d = await svc.previewGrid([["Model Code", "Name", "Type", "Balance"], ["OLD", "Old", "Bike", 4], ["HAS", "Has", "Skate", 5], ["QUIET", "Quiet", "Bike", 1]]);
    expect(d.flags.map((f) => f.model)).toEqual([]); // OLD maps (Bike), HAS already has one, QUIET is not written
    await svc.apply(d.batchId);
    const rc = Object.fromEntries(state.products.map((p) => [p.model, p.revenueCategoryId ?? null]));
    expect(rc).toEqual({ OLD: "rc-bike", HAS: "rc-miller", QUIET: null });
  });
  test("a store without revenue categories maps nothing and flags nothing (the older fakes keep working)", async () => {
    const { svc, state } = memoryStore([]);
    const d = await svc.previewGrid(G(["A", "a", "Bike", 1]));
    expect(d.flags).toEqual([]);
    await svc.apply(d.batchId);
    expect(state.products[0].revenueCategoryId ?? null).toBeNull();
  });
  test("migration 0018: ONE nullable column with an FK to bo.revenue_category, additive, journaled, witnessed; the schema declares it", async () => {
    const M = (await file("../../drizzle/0018_bo_item_revenue_category.sql")).replace(/^--.*$/gm, "");
    expect(M.trim()).toBe('ALTER TABLE "bo"."item" ADD COLUMN IF NOT EXISTS "revenue_category_id" uuid REFERENCES "bo"."revenue_category"("id") ON DELETE SET NULL;');
    expect(await file("../../drizzle/meta/_journal.json")).toContain('"tag": "0018_bo_item_revenue_category"');
    const W = await file("../lib/migration-witness.ts");
    expect(W).toContain('tag: "0018_bo_item_revenue_category"');
    expect(W).toContain('column: "revenue_category_id"');
    expect(await file("../db/schema.ts")).toContain('revenueCategoryId: uuid("revenue_category_id")');
  });
});

describe("the staging — 30 minutes, a cap, and what a missing batch means", () => {
  test("an unknown batchId ⇒ 404 BATCH_NOT_FOUND (nothing written)", async () => {
    const { svc, state } = memoryStore([]);
    const err = await svc.apply("0".repeat(32)).catch((e) => e);
    expect(err).toBeInstanceOf(ApiException);
    expect(err.status).toBe(404);
    expect(err.code).toBe("BATCH_NOT_FOUND");
    expect(state.movements).toEqual([]);
  });
  test("a preview expires after 30 minutes (404), is alive at 29; and an expired batch that WAS applied still answers alreadyApplied", async () => {
    let t = 1_000_000;
    const m = memoryStore([P({ model: "A", name: "A", qty: 1 })]);
    const svc = createStockImportService(m.store, createStaging(() => t));
    const d1 = await svc.previewGrid([["Model Code", "Name", "Balance"], ["A", "A", 4]]);
    t += 29 * 60_000;
    expect(svc.staged(d1.batchId)).not.toBeNull();
    t += 2 * 60_000;
    expect(svc.staged(d1.batchId)).toBeNull();
    expect((await svc.apply(d1.batchId).catch((e) => e)).code).toBe("BATCH_NOT_FOUND");
    const d2 = await svc.previewGrid([["Model Code", "Name", "Balance"], ["A", "A", 6]]);
    await svc.apply(d2.batchId);
    t += 60 * 60_000;
    expect(svc.staged(d2.batchId)).toBeNull();
    const again = await svc.apply(d2.batchId);
    expect(again).toMatchObject({ alreadyApplied: true, movementsWritten: 0 });
  });
  test("at most 20 batches are held — the oldest goes", () => {
    const st = createStaging(() => 0);
    for (let i = 0; i < 25; i++) st.put(String(i), []);
    expect(st.size()).toBe(20);
    expect(st.get("0")).toBeNull();
    expect(st.get("24")).not.toBeNull();
  });
  test("the same file previewed twice ⇒ the same batchId", async () => {
    const { svc } = memoryStore([]);
    const g = [["Model Code", "Name", "Balance"], ["A", "A", 1]];
    expect((await svc.previewGrid(g)).batchId).toBe((await svc.previewGrid(g)).batchId);
  });
});

describe("the preview envelope — rows with before / after as the screen reads them", () => {
  test("new / qty_change / field_change / removed map to {model,name,kind,before,after,delta}", async () => {
    const { svc } = memoryStore([P({ model: "A", name: "Alpha", qty: 5, priceMinor: 1000 }), P({ model: "B", name: "Beta", qty: 2 }), P({ model: "GONE", name: "Gone", qty: 7 })]);
    const d = await svc.previewGrid([["Model Code", "Name", "Price", "Type", "Balance"], ["A", "Alpha", "11", "", 9], ["B", "Beta 2", "", "", 2], ["NEW", "Fresh", "5.50", "Bike", 4]]);
    const r = Object.fromEntries(d.rows.map((x) => [x.model, x]));
    expect(r.A).toEqual({ model: "A", name: "Alpha", kind: "qty_change", before: { quantity: 5, priceSatang: 1000 }, after: { quantity: 9, priceSatang: 1100 }, delta: 4 });
    expect(r.B).toEqual({ model: "B", name: "Beta 2", kind: "field_change", before: { name: "Beta" }, after: { name: "Beta 2" }, delta: 0 });
    expect(r.NEW).toEqual({ model: "NEW", name: "Fresh", kind: "new", before: { quantity: null, name: null, priceSatang: null, category: null }, after: { quantity: 4, name: "Fresh", priceSatang: 550, category: "Bike" }, delta: 4 });
    expect(r.GONE).toEqual({ model: "GONE", name: "Gone", kind: "removed", before: { name: "Gone", quantity: 7 }, after: {}, delta: 0 });
    expect(Object.keys(d).sort()).toEqual(["batchId", "flags", "notImported", "rows", "unchanged"]);
  });
});

describe("the .xlsx reader — a real generated workbook", () => {
  const book = async (build: (wb: ExcelJS.Workbook) => void) => {
    const wb = new ExcelJS.Workbook();
    build(wb);
    return new Uint8Array(await wb.xlsx.writeBuffer());
  };
  test("reads the «Balance Stock» tab (not «Demo») with the two-row header, formulas and numbers", async () => {
    const bytes = await book((wb) => {
      const demo = wb.addWorksheet("Demo");
      demo.addRow(["Item", "Bravo"]); demo.addRow(["x", 1]);
      const ws = wb.addWorksheet("Balance Stock");
      wb.addWorksheet("Notes").addRow(["Model Code", "Name"]);
      ws.addRow(["Model Code", "Name", "Type", "Balance", "Balance", "Remark"]);
      ws.addRow(["Model Code", "Name", "Type", "Bravo", "Other", "Remark"]);
      ws.addRow(["C/BPD01", "Butt PAD", "Skate", 3, 9, "r"]);
      ws.addRow(["C/BPD02", "Butt 2", "Skate", { formula: "1+1", result: 2 }, 0, ""]);
    });
    const { svc } = memoryStore([]);
    const d = await svc.preview(bytes);
    expect(d.rows.map((e) => [e.model, e.kind, e.delta])).toEqual([["C/BPD01", "new", 3], ["C/BPD02", "new", 2]]);
    expect(d.notImported).toContain("Other (future branches)");
  });
  test("not an xlsx, empty, too big, or a broken zip ⇒ a 400, never a crash", async () => {
    const { svc } = memoryStore([]);
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big[0] = 0x50; big[1] = 0x4b; // looks like a zip, but too big
    const cases: Array<[Uint8Array, string]> = [[new Uint8Array(0), "ไฟล์ว่าง"], [new TextEncoder().encode("a,b\n1,2"), "ต้องเป็น .xlsx"], [new Uint8Array([0x50, 0x4b, 1, 2, 3, 4]), "อ่านไฟล์ .xlsx ไม่ได้"], [big, "5 MB"]];
    for (const [bytes, msg] of cases) {
      const err = await svc.preview(bytes).catch((e) => e);
      expect(err).toBeInstanceOf(ApiException);
      expect(err.status).toBe(400);
      expect(err.message).toContain(msg);
    }
  });
  test("a sheet with bad cells ⇒ 400 listing them, and nothing is written", async () => {
    const bytes = await book((wb) => { const ws = wb.addWorksheet("Balance Stock"); ws.addRow(["Model Code", "Name", "Balance"]); ws.addRow(["A", "n", -3]); ws.addRow(["", "n", 1]); });
    const { svc, state } = memoryStore([]);
    const err = await svc.preview(bytes).catch((e) => e);
    expect(err.status).toBe(400);
    expect((err.details as { errors: unknown[] }).errors).toHaveLength(2);
    expect(state.movements).toEqual([]);
  });
  test("readStockGrid picks the first sheet when none is called «balance»", async () => {
    const g = await readStockGrid(await book((wb) => { wb.addWorksheet("Sheet1").addRow(["Model Code", "Name"]); }));
    expect(g[0]).toEqual(["Model Code", "Name"]);
  });
  test("preview WRITES NOTHING (the memory store sees no transaction)", async () => {
    let txs = 0;
    const store: StockStore = { products: async () => [], transaction: async () => { txs++; throw new Error("no"); } };
    const bytes = await book((wb) => { const ws = wb.addWorksheet("Balance Stock"); ws.addRow(["Model Code", "Name", "Balance"]); ws.addRow(["A", "n", 1]); });
    await createStockImportService(store).preview(bytes);
    expect(txs).toBe(0);
  });
});

describe("the reads — pure bits", () => {
  test("movement type: import/adjust refs ⇒ ADJUSTMENT, FROM_DEMO, else by sign", () => {
    expect(movementTypeOf({ qty: 5, refType: "STOCK_IMPORT" })).toBe("ADJUSTMENT");
    expect(movementTypeOf({ qty: -5, refType: "ADJUSTMENT" })).toBe("ADJUSTMENT");
    expect(movementTypeOf({ qty: 2, refType: "FROM_DEMO" })).toBe("FROM_DEMO");
    expect(movementTypeOf({ qty: -1, refType: "SALE" })).toBe("SALE");
    expect(movementTypeOf({ qty: -1, refType: null })).toBe("SALE");
    expect(movementTypeOf({ qty: 3, refType: null })).toBe("STOCK_IN");
    expect([...MOVEMENT_TYPES]).toEqual(["SALE", "STOCK_IN", "ADJUSTMENT", "FROM_DEMO"]);
  });
  test("daysBetween: real days only, inclusive span", () => {
    expect(daysBetween("2026-11-01", "2026-11-09")).toBe(8);
    expect(daysBetween("2026-11-09", "2026-11-09")).toBe(0);
    expect(daysBetween("2026-11-09", "2026-11-01")).toBe(-8);
    expect(daysBetween("2026-02-30", "2026-03-01")).toBeNull();
    expect(daysBetween("2026-13-01", "2026-03-01")).toBeNull();
    expect(daysBetween("x", "2026-03-01")).toBeNull();
    expect(daysBetween("2025-01-01", "2026-01-01")).toBe(365);
  });
  test("Bangkok day bounds: from 00:00 +07 to the day AFTER `to` (inclusive to)", () => {
    const { start, end } = bangkokDayBounds("2026-11-01", "2026-11-02");
    expect(start.toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-02T17:00:00.000Z");
  });
  test("LIKE escaping makes % _ \\ literal", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});

describe("the movement report window is refused before any query", () => {
  test("> 366 days, from after to, and a non-day are 400s", async () => {
    const { listStockMovements } = await import("./stock-read.service");
    for (const q of [{ from: "2025-01-01", to: "2026-11-09" }, { from: "2026-11-09", to: "2026-11-01" }, { from: "2026-02-30", to: "2026-03-01" }]) {
      const err = await listStockMovements({ ...q, limit: 10 }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiException);
      expect(err.status).toBe(400);
    }
    const tooLong = await listStockMovements({ from: "2025-01-01", to: "2026-01-02", limit: 10 }).catch((e) => e); // 366 days apart ⇒ 367 days inclusive
    expect(tooLong.status).toBe(400);
  });
});

describe("source pins — who may call what, and what is written", () => {
  test("the import is CEO-only, the reads are ceo + admin, and the router is mounted", async () => {
    const R = await file("../routes/stock.ts");
    expect(R).toContain('.post("/import/preview", requireRole("ceo"),');
    expect(R).toContain('.post("/import/apply", requireRole("ceo"),');
    expect(R).toContain('.get("/products", adminAuth,');
    const api = await file("../routes/api.ts");
    expect(api).toContain('.route("/stock", stockRoutes)');
    const bo = await file("../routes/bo.ts");
    expect(bo).toContain('"/stock/movements",\n    adminAuth,');
  });
  test("the apply body is {batchId} ONLY: a 32-hex id; a re-sent diff / entries / anything else is refused", async () => {
    const { applyBody } = await import("../routes/stock");
    expect(applyBody.safeParse({ batchId: "a".repeat(32) }).success).toBe(true);
    for (const bad of [{}, { batchId: "xyz" }, { batchId: "A".repeat(32) }, { batchId: "a".repeat(31) }, { batchId: 5 }, { entries: [] }]) expect(applyBody.safeParse(bad).success).toBe(false);
    expect(applyBody.safeParse({ batchId: "a".repeat(32), entries: [{ model: "A" }] }).success).toBe(true); // extra keys are stripped, never read
    expect(Object.keys(applyBody.parse({ batchId: "a".repeat(32), entries: [{ model: "A" }] }))).toEqual(["batchId"]);
  });
  test("NEGATIVE_BALANCE / STALE / BATCH_NOT_FOUND all take the app's ONE error envelope: the routes add no special body, the global onError renders {error:{code,message,details}}", async () => {
    const R = (await file("../routes/stock.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(R).not.toContain("negativeBalanceBody");
    expect(R).not.toContain("catch (e)");
    const I = (await file("../index.ts")).replace(/\r\n/g, "\n");
    expect(I).toContain("{ error: { code: err.code, message: err.message, details: err.details } }");
    expect(R).toContain("stockImportService.apply(c.req.valid(\"json\").batchId)");
  });
  test("the service: stock movements carry value 0 (a count is not a sale, so never in the P&L), the batch key, and NO delete anywhere", async () => {
    const S = await file("./stock-import.service.ts");
    const code = S.replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("valueMinor: 0,");
    expect(code).toContain('refType: "STOCK_IMPORT"');
    expect(code).not.toContain("tx.delete(boItem)");
    expect(code).not.toContain("tx.delete(boMovement)");
    expect(code).toContain('direction: "INCOME"');
    expect(code).toContain("ceilingQty: null");
    expect(code).toContain(".for(\"update\")");
  });
  test("the movement report has no money in its response and reads stock products only", async () => {
    const R = (await file("./stock-read.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(R).not.toContain("valueMinor");
    expect(R.split("eq(boItem.externalSource, STOCK_SOURCE)").length - 1).toBe(3); // the products list, the movement report, and 🔻 TASK-928: the sales history's shared window filter (was 2)
    const S = (await file("./stock-import.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(S).toContain("const q = exec.select().from(boItem).where(eq(boItem.externalSource, STOCK_SOURCE));");
    expect(STOCK_SOURCE).toBe("stock");
  });
  test("migration 0015: ONE nullable column, additive, journaled, witnessed", async () => {
    const M = (await file("../../drizzle/0015_bo_item_commission_group.sql")).replace(/^--.*$/gm, "");
    expect(M.trim()).toBe('ALTER TABLE "bo"."item" ADD COLUMN IF NOT EXISTS "commission_group" text;');
    const J = await file("../../drizzle/meta/_journal.json");
    expect(J).toContain('"tag": "0015_bo_item_commission_group"');
    const W = await file("../lib/migration-witness.ts");
    expect(W).toContain('tag: "0015_bo_item_commission_group"');
    expect(W).toContain('column: "commission_group"');
    expect(await file("../db/schema.ts")).toContain('commissionGroup: text("commission_group")');
  });
});
