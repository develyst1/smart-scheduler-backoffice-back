// TASK-915 - Stock DEMO: the Demo-sheet parser, the writes (move / defect-in / delete / sites), the negative refusal, idempotency, and the route gates. DB-less: an in-memory DemoStore.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { parseDemoGrid, tidy } from "../lib/demo-stock";
import { ApiException } from "../lib/http";
import { signToken, type Role } from "../lib/jwt";
import { demoRoutes } from "../routes/demo";
import { createDemoService, type DemoItemRow, type DemoMovementIn, type DemoSiteRow, type DemoStore, type DemoTx } from "./demo-stock.service";

// ───────────── the parser: a grid shaped like the customer's «Demo» tab ─────────────
const GRID: unknown[][] = [
  ["Category", "Name", "Location/ Balance", "Location/ Balance", "Location/ Balance", "Location/ Balance", "Location/ Balance", "Location/ Balance", null],
  ["Category", "Name", "Bravo", "STA", null, "RIS", "ABC", "Abbey", "Remark"],
  [" Protection Pad", "สนับจีน xxs", 22, 0, 0, 0, null, 0, null],
  [" Protection Pad", "สนับ / ชุด -Red+Black", 3, null, null, null, null, null, "ใส่สีแค่ Red/ Blue"],
  [" Protection Pad", "สนับ / ชุด -Red+Black", 3],
  ["\nHelmet", "หมวก xs", 22, 4, 5, 2, 0, 2], // col E = 5 must be IGNORED (the unnamed column)
  ["Inlineskate\n(Decahtlon)", "รอครูนับ"],
  ["Doll", "รอครูนับ", 1],
  [null, null, null, null], // a spacer
  ["Doll", "   ", 5], // blank name: a spacer
  ["Bike", "Balance bike", -2, 1.5, "x", 7, "x"], // Bravo -2, STA 1.5, (E "x" ignored), RIS 7, ABC "x"
];
describe("the Demo sheet parser", () => {
  const seed = parseDemoGrid(GRID);
  test("rows with a name become items (spacers skipped and counted); duplicate names are KEPT; category and remark are tidied", () => {
    expect(seed.rows.map((r) => r.name)).toEqual(["สนับจีน xxs", "สนับ / ชุด -Red+Black", "สนับ / ชุด -Red+Black", "หมวก xs", "รอครูนับ", "รอครูนับ", "Balance bike"]);
    expect(seed.skippedBlank).toBe(2);
    expect(seed.rows.map((r) => r.category)).toEqual(["Protection Pad", "Protection Pad", "Protection Pad", "Helmet", "Inlineskate (Decahtlon)", "Doll", "Bike"]);
    expect(seed.rows[1]!.remark).toBe("ใส่สีแค่ Red/ Blue");
    expect(seed.rows.map((r) => r.sheetRow)).toEqual([3, 4, 5, 6, 7, 8, 11]);
  });
  test("balances per site by header (Abbey = WA (Abbey)); zeros and blanks are not recorded; the UNNAMED column E is ignored", () => {
    expect(seed.rows[0]!.balances).toEqual({ Bravo: 22 });
    expect(seed.rows[3]!.balances).toEqual({ Bravo: 22, STA: 4, RIS: 2, "WA (Abbey)": 2 }); // E (5) is not KIS, it is dropped
    expect(seed.rows.every((r) => !("KIS" in r.balances))).toBe(true);
    expect(seed.sites).toEqual(["Bravo", "STA", "ABC", "RIS", "WA (Abbey)", "KIS"]);
  });
  test("a negative, fractional or non-numeric cell is a warning and is skipped", () => {
    expect(seed.rows[6]!.balances).toEqual({ RIS: 7 });
    expect(seed.warnings.length).toBe(3);
  });
  test("tidy collapses whitespace, newlines and nbsp", () => {
    expect(tidy("\n Helmet ")).toBe("Helmet");
    expect(tidy("a  b")).toBe("a b");
    expect(tidy("   ")).toBeNull();
    expect(tidy(null)).toBeNull();
  });
});

// ───────────── the service, over an in-memory store ─────────────
const NOW = new Date("2026-11-09T05:00:00Z"); // Bangkok 2026-11-09
function memory() {
  const sites: DemoSiteRow[] = ["Bravo", "STA", "ABC"].map((name, i) => ({ id: `0000000${i + 1}-0000-4000-8000-000000000000`, name, sortOrder: i, active: true }));
  const items: DemoItemRow[] = [{ id: "11111111-1111-4111-8111-111111111111", category: "Helmet", name: "Helmet M", remark: null, active: true, saleItemId: null }, { id: "22222222-2222-4222-8222-222222222222", category: "Bike", name: "Balance bike", remark: null, active: true, saleItemId: null }];
  const stock = new Map<string, number>(); // `${item}|${site}`
  const movements: DemoMovementIn[] = [];
  const [BRAVO, STA, ABC] = sites.map((s) => s.id) as [string, string, string];
  stock.set(`${items[0]!.id}|${BRAVO}`, 10);
  const tx: DemoTx = {
    sites: async () => sites.map((s) => ({ ...s })),
    lockItem: async (id) => items.find((i) => i.id === id) ?? null,
    balancesOf: async (itemId) => [...stock].filter(([k]) => k.startsWith(`${itemId}|`)).map(([k, qty]) => ({ siteId: k.split("|")[1]!, qty })),
    setBalance: async (itemId, siteId, qty) => void stock.set(`${itemId}|${siteId}`, qty),
    addMovement: async (m) => void movements.push(m),
    countKeyPrefix: async (p) => movements.filter((m) => m.idempotencyKey.startsWith(p)).length,
    deactivateItem: async (id) => void (items.find((i) => i.id === id)!.active = false),
    insertSite: async (name, sortOrder) => {
      const s = { id: `0000000${sites.length + 1}-0000-4000-8000-000000000000`, name, sortOrder, active: true };
      sites.push(s);
      return s;
    },
    setSiteOrder: async (ids) => ids.forEach((id, i) => void (sites.find((s) => s.id === id)!.sortOrder = i)),
  };
  const store: DemoStore = { transaction: async (fn) => fn(tx) };
  const bal = (item: string, site: string) => stock.get(`${item}|${site}`) ?? 0;
  return { sites, items, movements, stock, bal, BRAVO, STA, ABC, svc: createDemoService(store, () => NOW), H: items[0]!.id, B: items[1]!.id };
}
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
const K = (n: string) => `key-${n}-00000000`;

describe("Move A -> B", () => {
  test("-qty at A, +qty at B, ONE history row with from/to/reason/who/occurredOn; the response carries the new balances", async () => {
    const m = memory();
    const r = await m.svc.move({ key: K("1"), itemId: m.H, fromSiteId: m.BRAVO, toSiteId: m.STA, qty: 4, reason: "Needed for Tuesday" }, "ploy");
    expect(r).toMatchObject({ occurredOn: "2026-11-09", movementsWritten: 1, balances: { [m.BRAVO]: 6, [m.STA]: 4 } });
    expect(m.bal(m.H, m.BRAVO)).toBe(6);
    expect(m.bal(m.H, m.STA)).toBe(4);
    expect(m.movements).toEqual([{ itemId: m.H, type: "MOVE", qty: 4, fromSiteId: m.BRAVO, toSiteId: m.STA, reason: "Needed for Tuesday", actor: "ploy", occurredOn: "2026-11-09", idempotencyKey: `demo:${K("1")}:1` }]);
  });
  test("🔴 more than A has => 409 NEGATIVE_BALANCE naming the item, nothing written", async () => {
    const m = memory();
    const e = await rejects(m.svc.move({ key: K("2"), itemId: m.H, fromSiteId: m.BRAVO, toSiteId: m.STA, qty: 11, reason: "x" }, null), 409, "NEGATIVE_BALANCE");
    expect(e.details).toMatchObject({ itemId: m.H, siteId: m.BRAVO, resultingBalance: -1 });
    expect(m.movements).toHaveLength(0);
    expect(m.bal(m.H, m.BRAVO)).toBe(10);
    await rejects(m.svc.move({ key: K("3"), itemId: m.H, fromSiteId: m.STA, toSiteId: m.ABC, qty: 1, reason: "x" }, null), 409, "NEGATIVE_BALANCE"); // STA has none
  });
  test("a reason is REQUIRED; the same site both ends, qty 0 / fractional, bad key, unknown item / site are refused", async () => {
    const m = memory();
    const ok = { key: K("4"), itemId: m.H, fromSiteId: m.BRAVO, toSiteId: m.STA, qty: 1, reason: "r" };
    await rejects(m.svc.move({ ...ok, reason: "  " }, null), 400);
    await rejects(m.svc.move({ ...ok, toSiteId: m.BRAVO }, null), 400);
    await rejects(m.svc.move({ ...ok, qty: 0 }, null), 400);
    await rejects(m.svc.move({ ...ok, qty: 1.5 }, null), 400);
    await rejects(m.svc.move({ ...ok, key: "short" }, null), 400);
    await rejects(m.svc.move({ ...ok, itemId: "99999999-9999-4999-8999-999999999999" }, null), 404, "UNKNOWN_ITEM");
    await rejects(m.svc.move({ ...ok, toSiteId: "99999999-9999-4999-8999-999999999999" }, null), 404, "UNKNOWN_SITE");
    await rejects(m.svc.move({ ...ok, occurredOn: "2026-11-10" }, null), 400); // tomorrow
    await rejects(m.svc.move({ ...ok, occurredOn: "2026-02-30" }, null), 400);
    expect(m.movements).toHaveLength(0);
  });
  test("idempotent: the same key again writes nothing and answers alreadyApplied (with the current balances)", async () => {
    const m = memory();
    const body = { key: K("5"), itemId: m.H, fromSiteId: m.BRAVO, toSiteId: m.STA, qty: 4, reason: "r" };
    await m.svc.move(body, null);
    const again = await m.svc.move(body, null);
    expect(again).toMatchObject({ alreadyApplied: true, balances: { [m.BRAVO]: 6, [m.STA]: 4 } });
    expect(m.movements).toHaveLength(1);
  });
  test("a back-dated move keeps its own business day", async () => {
    const m = memory();
    await m.svc.move({ key: K("6"), itemId: m.H, fromSiteId: m.BRAVO, toSiteId: m.STA, qty: 1, reason: "r", occurredOn: "2026-11-03" }, null);
    expect(m.movements[0]!.occurredOn).toBe("2026-11-03");
  });
});

describe("Defect Product -> Demo (a plain +qty)", () => {
  test("+qty at a site, reason required, one DEFECT_IN row with no from-site, and NOTHING else changes", async () => {
    const m = memory();
    const r = await m.svc.defectIn({ key: K("7"), itemId: m.B, toSiteId: m.ABC, qty: 2, reason: "wheel cracked, fine to teach with" }, "ton");
    expect(r.balances).toEqual({ [m.ABC]: 2 });
    expect(m.movements[0]).toMatchObject({ type: "DEFECT_IN", qty: 2, fromSiteId: null, toSiteId: m.ABC, actor: "ton" });
    await rejects(m.svc.defectIn({ key: K("8"), itemId: m.B, toSiteId: m.ABC, qty: 1, reason: "" }, null), 400);
    expect((await m.svc.defectIn({ key: K("7"), itemId: m.B, toSiteId: m.ABC, qty: 2, reason: "x" }, null)).alreadyApplied).toBe(true);
    expect(m.bal(m.B, m.ABC)).toBe(2);
  });
});

describe("Delete (write-off, reason required)", () => {
  test("with siteId + qty: that many off that site; refused when it has fewer; the item stays", async () => {
    const m = memory();
    await m.svc.remove({ key: K("9"), itemId: m.H, reason: "lost at an event", siteId: m.BRAVO, qty: 3 }, "may");
    expect(m.bal(m.H, m.BRAVO)).toBe(7);
    expect(m.movements[0]).toMatchObject({ type: "WRITE_OFF", qty: 3, fromSiteId: m.BRAVO, toSiteId: null });
    expect(m.items[0]!.active).toBe(true);
    await rejects(m.svc.remove({ key: K("10"), itemId: m.H, reason: "r", siteId: m.BRAVO, qty: 8 }, null), 409, "NEGATIVE_BALANCE");
  });
  test("without them: zero EVERY site (one WRITE_OFF each) and deactivate the item; the history stays; a repeat is alreadyApplied", async () => {
    const m = memory();
    await m.svc.move({ key: K("11"), itemId: m.H, fromSiteId: m.BRAVO, toSiteId: m.STA, qty: 4, reason: "r" }, null);
    const r = await m.svc.remove({ key: K("12"), itemId: m.H, reason: "retired" }, null);
    expect(r).toMatchObject({ movementsWritten: 2, balances: { [m.BRAVO]: 0, [m.STA]: 0 } });
    expect(m.items[0]!.active).toBe(false);
    expect(m.movements.filter((x) => x.type === "WRITE_OFF").map((x) => [x.fromSiteId, x.qty]).sort()).toEqual([[m.BRAVO, 6], [m.STA, 4]].sort());
    expect(m.movements.length).toBe(3); // the move is still there: nothing is deleted
    expect((await m.svc.remove({ key: K("12"), itemId: m.H, reason: "retired" }, null)).alreadyApplied).toBe(true);
    await rejects(m.svc.move({ key: K("13"), itemId: m.H, fromSiteId: m.BRAVO, toSiteId: m.STA, qty: 1, reason: "r" }, null), 409, "ITEM_INACTIVE");
  });
  test("a reason is required; siteId and qty go together", async () => {
    const m = memory();
    await rejects(m.svc.remove({ key: K("14"), itemId: m.H, reason: "" }, null), 400);
    await rejects(m.svc.remove({ key: K("15"), itemId: m.H, reason: "r", siteId: m.BRAVO }, null), 400);
    await rejects(m.svc.remove({ key: K("16"), itemId: m.H, reason: "r", qty: 1 }, null), 400);
    expect(m.movements).toHaveLength(0);
  });
});

describe("sites: Add Location and Location Order", () => {
  test("a new site is appended last; a duplicate name (case-insensitive) is 409 DUPLICATE_SITE", async () => {
    const m = memory();
    const s = await m.svc.addSite("  ISB ");
    expect(s).toMatchObject({ name: "ISB", sortOrder: 3 });
    await rejects(m.svc.addSite("isb"), 409, "DUPLICATE_SITE");
    await rejects(m.svc.addSite("   "), 400);
  });
  test("order: the ids must be exactly the active sites, each once; the stored order follows", async () => {
    const m = memory();
    await m.svc.orderSites([m.ABC, m.BRAVO, m.STA]);
    expect(m.sites.sort((a, b) => a.sortOrder - b.sortOrder).map((s) => s.name)).toEqual(["ABC", "Bravo", "STA"]);
    await rejects(m.svc.orderSites([m.ABC, m.BRAVO]), 400);
    await rejects(m.svc.orderSites([m.ABC, m.ABC, m.STA]), 400);
    await rejects(m.svc.orderSites([m.ABC, m.BRAVO, "99999999-9999-4999-8999-999999999999"]), 400);
  });
});

describe("the routes' gates (no database: they stop before the handler)", () => {
  const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.JWT_SECRET = "test-secret-915";
    process.env.SKIP_ADMIN_AUTH = "false";
  });
  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const app = new Hono().onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code } }, err.status as 400) : c.json({ error: { code: "INTERNAL" } }, 500))).route("/demo", demoRoutes);
  const call = async (method: string, path: string, role: Role | null, body?: unknown) =>
    app.request(`/demo${path}`, { method, headers: { ...(role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ID = "11111111-1111-4111-8111-111111111111";
  const SITE = "22222222-2222-4222-8222-222222222222";

  test("EVERY demo route: none 401, coach 403 (admin and ceo are allowed)", async () => {
    const calls: [string, string, unknown][] = [
      ["GET", "/sites", undefined], ["GET", "/stock", undefined], ["GET", "/movements?from=2026-11-01&to=2026-11-09", undefined],
      ["POST", "/move", {}], ["POST", "/defect-in", {}], ["POST", "/delete", {}], ["POST", "/sites", {}], ["PUT", "/sites/order", {}],
    ];
    for (const [m, p, b] of calls) {
      expect([m, p, (await call(m, p, null, b)).status]).toEqual([m, p, 401]);
      expect([m, p, (await call(m, p, "coach", b)).status]).toEqual([m, p, 403]);
    }
  });
  test("admin and ceo pass the gate: a bad body is a 400 (before any database)", async () => {
    for (const role of ["admin", "ceo"] as const) {
      expect((await call("POST", "/move", role, { key: "short" })).status).toBe(400);
      expect((await call("POST", "/move", role, { key: "key-12345678", itemId: ID, fromSiteId: SITE, toSiteId: SITE, qty: 0, reason: "r" })).status).toBe(400);
      expect((await call("POST", "/move", role, { key: "key-12345678", itemId: ID, fromSiteId: SITE, toSiteId: SITE, qty: 1 })).status).toBe(400); // no reason
      expect((await call("POST", "/defect-in", role, { key: "key-12345678", itemId: ID, toSiteId: SITE, qty: 1 })).status).toBe(400);
      expect((await call("POST", "/delete", role, { key: "key-12345678", itemId: ID })).status).toBe(400);
      expect((await call("POST", "/sites", role, { name: "" })).status).toBe(400);
      expect((await call("PUT", "/sites/order", role, { ids: ["nope"] })).status).toBe(400);
      expect((await call("GET", "/movements?from=2026-11-01", role)).status).toBe(400);
      expect((await call("GET", "/movements?from=2026-11-01&to=2026-11-09&type=SALE", role)).status).toBe(400); // not a demo type
    }
  });
});
