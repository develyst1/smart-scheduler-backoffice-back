// TASK-919 (REQ-120 R3.7) — Low Stock, DB-free: the thresholds validation, the low rule, the ISO week, the text, the service over a memory store with a fake notifier (Jason's seam), the job's
// endpoint gate, the .ps1 and the pins. Each test must fail when its line in the code goes (mutation set: low-stock-task919.mutations.json).
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ApiException } from "../lib/http";
import { DEFAULT_LOW_STOCK_THRESHOLDS, isoWeekOf, lowStockRows, lowStockText, parseThresholds, weeklyKey, type LowInput, type Thresholds } from "../lib/low-stock";
import { createLowStockService, type LowStockStore, type Notifier } from "./low-stock.service";

const file = async (p: string) => (await Bun.file(new URL(p, import.meta.url)).text()).replace(/\r\n/g, "\n");
const P = (model: string, category: string | null, qty: number | null, o: Partial<LowInput> = {}): LowInput => ({ id: `id-${model}`, model, name: `Name ${model}`, category, qty, active: true, ...o });

describe("parseThresholds — the whole map, every problem at once", () => {
  test("a valid map: whole numbers ≥ 0 and null (no alert); keys are trimmed", () => {
    const r = parseThresholds({ " F&B ": 10, Safety: 0, Miller: null });
    expect(r.issues).toEqual([]);
    expect(r.value).toEqual({ "F&B": 10, Safety: 0, Miller: null });
  });
  test("refused: negative, fractional, a string, NaN-ish, a huge level, an empty name, a long name, a case-insensitive repeat, not an object", () => {
    const keys = (x: unknown) => parseThresholds(x).issues.map((i) => i.key);
    expect(keys({ A: -1 })).toEqual(["A"]);
    expect(keys({ A: 1.5 })).toEqual(["A"]);
    expect(keys({ A: "3" })).toEqual(["A"]);
    expect(keys({ A: undefined })).toEqual(["A"]);
    expect(keys({ A: 1_000_000_001 })).toEqual(["A"]);
    expect(keys({ "  ": 1 })).toEqual(["  "]);
    expect(keys({ ["x".repeat(101)]: 1 })).toHaveLength(1);
    expect(parseThresholds({ Miller: 5, miller: 6 }).issues[0].message).toContain("repeats");
    for (const bad of [null, [], "x", 5]) expect(parseThresholds(bad).issues).toHaveLength(1);
  });
  test("every problem is collected, not just the first; the valid keys are still returned", () => {
    const r = parseThresholds({ A: -1, B: 2, C: 0.5 });
    expect(r.issues.map((i) => i.key)).toEqual(["A", "C"]);
    expect(r.value).toEqual({ B: 2 });
  });
  test("at most 200 types", () => {
    const big = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`T${i}`, 1]));
    expect(parseThresholds(big).issues).toHaveLength(1);
  });
  test("the defaults are the customer's: F&B 10 · Safety 1 · Miller 5 · Sock 1 · Shirt 1", () => {
    expect(DEFAULT_LOW_STOCK_THRESHOLDS).toEqual({ "F&B": 10, Safety: 1, Miller: 5, Sock: 1, Shirt: 1 });
  });
});

describe("lowStockRows — quantity ≤ the threshold of its category", () => {
  const T: Thresholds = { "F&B": 10, Miller: 5, Safety: 0, Off: null };
  test("exactly at the level is low; one above is not", () => {
    expect(lowStockRows([P("A", "Miller", 5), P("B", "Miller", 6)], T).map((r) => r.code)).toEqual(["A"]);
  });
  test("a category with NO threshold (absent or null) is never low — even at 0", () => {
    expect(lowStockRows([P("A", "Unknown", 0), P("B", "Off", 0)], T)).toEqual([]);
  });
  test("0 is low whenever the type HAS a level, including a level of 0", () => {
    expect(lowStockRows([P("A", "Safety", 0), P("B", "Safety", 1)], T).map((r) => r.code)).toEqual(["A"]);
  });
  test("the category matches by its exact name, trimmed and case-insensitive (no first-word guessing)", () => {
    expect(lowStockRows([P("A", " f&b ", 3), P("B", "Miller division", 1)], T).map((r) => r.code)).toEqual(["A"]);
  });
  test("an inactive product, a product with no tracked balance and one with no category are skipped", () => {
    expect(lowStockRows([P("A", "Miller", 1, { active: false }), P("B", "Miller", null), P("C", null, 1)], T)).toEqual([]);
  });
  test("each row: code, name, category, quantity, threshold, under (= threshold − quantity) — and NO money", () => {
    const [r] = lowStockRows([P("A", "Miller", 3)], T);
    expect(r).toEqual({ id: "id-A", code: "A", name: "Name A", category: "Miller", quantity: 3, threshold: 5, under: 2 });
    expect(JSON.stringify(r)).not.toMatch(/price|minor|satang|baht|฿/i);
  });
  test("sorted by category, then the furthest under first, then by name", () => {
    const rows = lowStockRows([P("Z", "Miller", 4, { name: "a" }), P("Y", "Miller", 1, { name: "z" }), P("X", "Miller", 1, { name: "m" }), P("W", "F&B", 9)], T);
    expect(rows.map((r) => r.code)).toEqual(["W", "X", "Y", "Z"]); // F&B first; Miller: the furthest under first (X «m», Y «z» — by name), then Z (under 1) even though its name sorts first
  });
});

describe("the ISO week and the notification text", () => {
  test("isoWeekOf: Monday 2026-11-09 is 2026-W46; the year edges follow ISO-8601", () => {
    expect(isoWeekOf("2026-11-09")).toBe("2026-W46");
    expect(isoWeekOf("2026-11-15")).toBe("2026-W46"); // Sunday
    expect(isoWeekOf("2026-11-16")).toBe("2026-W47");
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
    expect(isoWeekOf("2025-12-29")).toBe("2026-W01");
    expect(isoWeekOf("2021-01-03")).toBe("2020-W53");
    expect(isoWeekOf("2024-12-30")).toBe("2025-W01");
  });
  test("the key is low-stock:<week>", () => {
    expect(weeklyKey("2026-W46")).toBe("low-stock:2026-W46");
  });
  test("the text: how many, then the first 8 with quantity ≤ level, then «and K more»; singular for one; no money", () => {
    const rows = lowStockRows([P("A", "Miller", 3)], { Miller: 5 });
    expect(lowStockText(rows)).toBe("1 product is low on stock: A Name A (3 ≤ 5)");
    const many = lowStockRows(Array.from({ length: 10 }, (_, i) => P(`C${i}`, "Miller", 0)), { Miller: 5 });
    const t = lowStockText(many);
    expect(t.startsWith("10 products are low on stock: ")).toBe(true);
    expect(t.endsWith(", and 2 more")).toBe(true);
    expect(t.split("; ")).toHaveLength(8);
    expect(t).not.toMatch(/price|minor|satang|baht|฿/i);
  });
});

// ── the service over a memory store and Jason's seam (a fake notifier)
function setup(opts: { saved?: Thresholds | null; products?: LowInput[]; recipients?: string[] } = {}) {
  const st = { saved: opts.saved === undefined ? null : opts.saved, products: opts.products ?? [], by: null as string | null, txs: 0, replaced: 0 };
  const store: LowStockStore = {
    thresholds: async () => (st.saved ? { ...st.saved } : null),
    replaceThresholds: async (m, by) => { st.saved = { ...m }; st.by = by; st.replaced++; },
    products: async () => st.products.map((p) => ({ ...p })),
    transaction: async (fn) => { st.txs++; return fn({ products: async () => st.products.map((p) => ({ ...p })), thresholds: async () => (st.saved ? { ...st.saved } : null), exec: "TX" }); },
  };
  const notes = { recipientCalls: [] as unknown[], created: [] as Array<{ exec: unknown; recipientRef: string; type: string; text: string; occurredOn: string; key: string }>, seen: new Set<string>() };
  const notifier: Notifier = {
    recipientsForType: async (_t, exec) => { notes.recipientCalls.push(exec); return opts.recipients ?? ["ceo", "london"]; },
    createNotification: async (exec, n) => {
      const k = `${n.recipientRef}|${n.key}`;
      if (notes.seen.has(k)) return false;
      notes.seen.add(k);
      notes.created.push({ exec, ...n });
      return true;
    },
  };
  let nowMs = Date.parse("2026-11-09T02:00:00Z"); // Monday 09:00 Bangkok
  const svc = createLowStockService(store, notifier, () => new Date(nowMs));
  return { st, notes, svc, setNow: (iso: string) => { nowMs = Date.parse(iso); } };
}

describe("the thresholds store (the seam of TASK-913)", () => {
  test("never saved ⇒ the R3.7 defaults; after a save ⇒ exactly what was saved (the WHOLE map is replaced)", async () => {
    const { svc, st } = setup();
    expect(await svc.getThresholds()).toEqual({ "F&B": 10, Safety: 1, Miller: 5, Sock: 1, Shirt: 1 });
    expect(await svc.setThresholds({ Skate: 3, "F&B": null }, "ceo1")).toEqual({ Skate: 3, "F&B": null });
    expect(await svc.getThresholds()).toEqual({ Skate: 3, "F&B": null });
    expect(st.by).toBe("ceo1");
  });
  test("a bad map is a 400 listing every problem and NOTHING is written", async () => {
    const { svc, st } = setup({ saved: { A: 1 } });
    const err = await svc.setThresholds({ A: -1, B: 2.5 }, "ceo1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiException);
    expect([err.status, err.code]).toEqual([400, "VALIDATION"]);
    expect((err.details as { issues: unknown[] }).issues).toHaveLength(2);
    expect(st.replaced).toBe(0);
    expect(await svc.getThresholds()).toEqual({ A: 1 });
  });
  test("an EMPTY map is refused (it would empty the table, which reads back as «never saved» = the defaults); a type is switched off with a null level", async () => {
    const { svc, st } = setup({ saved: { A: 1 } });
    const err = await svc.setThresholds({}, "ceo1").catch((e) => e);
    expect([err.status, err.code]).toEqual([400, "VALIDATION"]);
    expect(st.replaced).toBe(0);
    await svc.setThresholds({ Miller: null }, "ceo1");
    const m2 = setup({ saved: { Miller: null }, products: [P("A", "Miller", 0)] });
    expect((await m2.svc.lowList()).items).toEqual([]); // a null level = never low
  });
  test("lowList = the rule over the products and the effective thresholds", async () => {
    const { svc } = setup({ products: [P("A", "Miller", 5), P("B", "Miller", 6), P("C", "Skate", 0)] });
    expect((await svc.lowList()).items.map((r) => r.code)).toEqual(["A"]); // defaults: Skate has no level
  });
});

describe("the Monday job", () => {
  const low = [P("A", "Miller", 3), P("B", "F&B", 2)];
  test("one notification per recipient of «Low Stock» (Jason's recipientsForType), key low-stock:<ISO week>, the Bangkok day, ONE text, the job's own transaction", async () => {
    const { svc, notes } = setup({ products: low });
    const r = await svc.runWeekly();
    expect(r).toEqual({ week: "2026-W46", low: 2, recipients: 2, posted: 2, alreadyPosted: 0 });
    expect(notes.created.map((n) => [n.recipientRef, n.type, n.key, n.occurredOn])).toEqual([["ceo", "Low Stock", "low-stock:2026-W46", "2026-11-09"], ["london", "Low Stock", "low-stock:2026-W46", "2026-11-09"]]);
    expect(notes.created[0].text).toBe("2 products are low on stock: B Name B (2 ≤ 10); A Name A (3 ≤ 5)");
    expect(notes.created.every((n) => n.exec === "TX")).toBe(true); // the notifier writes in the job's transaction
    expect(notes.recipientCalls).toEqual(["TX"]);
  });
  test("IDEMPOTENT per week: a re-run (or a manual run on Wednesday) posts nothing new", async () => {
    const { svc, notes, setNow } = setup({ products: low });
    await svc.runWeekly();
    setNow("2026-11-11T05:00:00Z");
    const again = await svc.runWeekly();
    expect(again).toEqual({ week: "2026-W46", low: 2, recipients: 2, posted: 0, alreadyPosted: 2 });
    expect(notes.created).toHaveLength(2);
  });
  test("the next ISO week posts again", async () => {
    const { svc, notes, setNow } = setup({ products: low });
    await svc.runWeekly();
    setNow("2026-11-16T02:00:00Z");
    const next = await svc.runWeekly();
    expect(next).toMatchObject({ week: "2026-W47", posted: 2 });
    expect(notes.created).toHaveLength(4);
  });
  test("the week is the BANGKOK week: Sunday 23:30 UTC is already Monday in Bangkok", async () => {
    const { svc, setNow } = setup({ products: low });
    setNow("2026-11-08T23:30:00Z"); // Sunday UTC = Monday 06:30 Bangkok
    expect((await svc.runWeekly()).week).toBe("2026-W46");
  });
  test("NOTHING low ⇒ nothing is written and the recipients are not even asked", async () => {
    const { svc, notes } = setup({ products: [P("A", "Miller", 99), P("B", "Skate", 0)] });
    expect(await svc.runWeekly()).toEqual({ week: "2026-W46", low: 0, recipients: 0, posted: 0, alreadyPosted: 0 });
    expect(notes.recipientCalls).toEqual([]);
    expect(notes.created).toEqual([]);
  });
  test("nobody assigned ⇒ low is reported, nothing posted", async () => {
    const { svc, notes } = setup({ products: low, recipients: [] });
    expect(await svc.runWeekly()).toEqual({ week: "2026-W46", low: 2, recipients: 0, posted: 0, alreadyPosted: 0 });
    expect(notes.created).toEqual([]);
  });
  test("a notifier failure propagates (the transaction is the caller's rollback) and no payload carries money", async () => {
    const m = setup({ products: low });
    const boom = createLowStockService({ ...({} as LowStockStore), transaction: (fn) => fn({ products: async () => low, thresholds: async () => null, exec: "TX" }), thresholds: async () => null, replaceThresholds: async () => {}, products: async () => low }, { recipientsForType: async () => ["a"], createNotification: async () => { throw new Error("feed down"); } }, () => new Date("2026-11-09T02:00:00Z"));
    expect(String(await boom.runWeekly().catch((e) => e))).toContain("feed down");
    await m.svc.runWeekly();
    expect(JSON.stringify(m.notes.created)).not.toMatch(/price|minor|satang|baht|฿/i);
  });
  test("a demo product is never in the run: only the stock products reach the rule (the store reads source «stock» only)", async () => {
    const S = (await file("./low-stock.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(S).toContain("readProducts(db, false)"); // the 904 reader = external_source 'stock'
    const I = (await file("./stock-import.service.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(I).toContain("const q = exec.select().from(boItem).where(eq(boItem.externalSource, STOCK_SOURCE));");
  });
});

describe("gates and pins", () => {
  test("the job endpoint is FAIL-CLOSED: no token / a wrong token / an empty SERVICE_TOKEN are all 401, and a user Bearer opens nothing", async () => {
    const { internalJobsRoutes } = await import("../routes/internal-jobs");
    const app = new Hono().route("/internal/jobs", internalJobsRoutes);
    app.onError((e, c) => (e instanceof ApiException ? c.json({ error: { code: e.code } }, e.status as 401) : c.json({ error: "internal" }, 500))); // the app's own onError (index.ts) maps an ApiException to its status
    const prev = process.env.SERVICE_TOKEN;
    try {
      process.env.SERVICE_TOKEN = "s3cret-token";
      expect((await app.request("/internal/jobs/low-stock-weekly", { method: "POST" })).status).toBe(401);
      expect((await app.request("/internal/jobs/low-stock-weekly", { method: "POST", headers: { "X-Service-Token": "wrong" } })).status).toBe(401);
      expect((await app.request("/internal/jobs/low-stock-weekly", { method: "POST", headers: { Authorization: "Bearer s3cret-token" } })).status).toBe(401);
      process.env.SERVICE_TOKEN = "";
      expect((await app.request("/internal/jobs/low-stock-weekly", { method: "POST", headers: { "X-Service-Token": "" } })).status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.SERVICE_TOKEN; else process.env.SERVICE_TOKEN = prev;
    }
  });
  test("the routes: the list + thresholds read are ceo + admin, the thresholds WRITE is CEO-only; the job is mounted under /internal/jobs", async () => {
    const R = (await file("../routes/stock.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(R).toContain('.get("/low-stock", adminAuth,');
    expect(R).toContain('.get("/low-stock/thresholds", adminAuth,');
    expect(R).toContain('.put("/low-stock/thresholds", adminAuth,'); // 🔻 Sober's ruling (919 § Review Q1): thresholds hold no money, so ceo + admin may edit them (was CEO-only)
    const A = (await file("../routes/api.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(A).toContain('.route("/internal/jobs", internalJobsRoutes)');
    const J = (await file("../routes/internal-jobs.ts")).replace(/^\s*\/\/.*$/gm, "");
    expect(J).toContain('.use("*", strictServiceToken)');
    expect(J).toContain('.post("/low-stock-weekly",');
  });
  test("the write body is {thresholds: object}; an array / missing key is refused before the service", async () => {
    const { lowStockBody } = await import("../routes/stock");
    expect(lowStockBody.safeParse({ thresholds: { A: 1 } }).success).toBe(true);
    for (const bad of [{}, { thresholds: [] }, { thresholds: "x" }, { thresholds: null }, []]) expect(lowStockBody.safeParse(bad).success).toBe(false);
  });
  test("no migration: the table + the seeded defaults come from 0020, and they equal the code's defaults", async () => {
    const M = await file("../../drizzle/0020_bo_notification.sql");
    expect(M).toContain('CREATE TABLE IF NOT EXISTS "bo"."low_stock_threshold"');
    for (const [k, v] of Object.entries(DEFAULT_LOW_STOCK_THRESHOLDS)) expect(M).toContain(`('${k}', ${v}, 'seed')`);
    expect(await file("../db/schema-notification.ts")).toContain("export const boLowStockThreshold = bo.table(");
  });
  test("the .ps1: NOT registered by itself, no secret in the file, needs BB_SERVICE_TOKEN, posts to the job's path with X-Service-Token", async () => {
    const P1 = await file("../../sm-jobs/low-stock-weekly.ps1");
    const body = P1.replace(/^\s*#.*$/gm, "");
    expect(body).not.toMatch(/Register-ScheduledTask|schtasks|New-ScheduledTask/i);
    expect(body).toContain("$env:BB_SERVICE_TOKEN");
    expect(body).toContain("exit 2");
    expect(body).toContain('"$base/api/v1/internal/jobs/low-stock-weekly"');
    expect(body).toContain('"X-Service-Token" = $token');
    expect(body).not.toMatch(/change-me|sid-server-task-schedule|SERVICE_TOKEN\s*=\s*["'][^"']/);
  });
});

describe("the thresholds write gate (Sober: ceo + admin, never a coach)", () => {
  test("no token 401 and a COACH 403 on the PUT; an admin and the CEO pass the gate (a bad body is then the validator's 400)", async () => {
    const { stockRoutes } = await import("../routes/stock");
    const { signToken } = await import("../lib/jwt");
    const prev = { s: process.env.JWT_SECRET, a: process.env.SKIP_ADMIN_AUTH };
    process.env.JWT_SECRET = "test-secret-919";
    process.env.SKIP_ADMIN_AUTH = "false";
    try {
      const app = new Hono();
      app.onError((e, c) => (e instanceof ApiException ? c.json({ error: { code: e.code } }, e.status as 400) : c.json({ error: "internal" }, 500)));
      app.route("/stock", stockRoutes);
      const put = async (role: "ceo" | "admin" | "coach" | null) =>
        app.request("/stock/low-stock/thresholds", { method: "PUT", headers: { "Content-Type": "application/json", ...(role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {}) }, body: JSON.stringify({ nope: 1 }) });
      expect((await put(null)).status).toBe(401);
      expect((await put("coach")).status).toBe(403);
      expect((await put("admin")).status).toBe(400); // past the gate, stopped by the body schema
      expect((await put("ceo")).status).toBe(400);
    } finally {
      if (prev.s === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prev.s;
      if (prev.a === undefined) delete process.env.SKIP_ADMIN_AUTH; else process.env.SKIP_ADMIN_AUTH = prev.a;
    }
  });
});
