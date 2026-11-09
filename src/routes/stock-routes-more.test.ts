// Route-level checks of the REMAINING mounted /stock routes THROUGH the real validators and gates (the first file, stock-routes.test.ts, covers POST /in and the write bodies of /out and /import/apply).
// Same pattern: a body that passes the gate and the validator reaches the handler, which cannot reach a database here — so «reached» = anything but 400 / 401 / 403.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { db } from "../db";
import { signToken, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";
import { stockRoutes } from "./stock";

// A request that passes the gate and the validator reaches a handler that talks to the database. There is none here, and a REAL connection attempt would leave the shared `db` client in a retry state that
// slows other test files; so the database calls are stubbed to fail at once (a 500 = «the handler ran»).
const dbStubs: Array<{ mockRestore: () => void }> = [];
beforeAll(() => { for (const k of ["select", "selectDistinct", "insert", "update", "delete", "execute", "transaction"]) dbStubs.push(spyOn(db as never, k as never).mockImplementation((() => { throw new Error("no database in this test"); }) as never)); });
afterAll(() => { for (const s of dbStubs.splice(0)) s.mockRestore(); });

const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; process.env.JWT_SECRET = "test-secret-stock-routes-2"; process.env.SKIP_ADMIN_AUTH = "false"; });
afterAll(() => { for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])); });

const app = () => {
  const a = new Hono();
  a.onError((e, c) => (e instanceof ApiException ? c.json({ error: { code: e.code, message: e.message } }, e.status as 400) : c.json({ error: "internal" }, 500)));
  return a.route("/stock", stockRoutes);
};
const tokenHeader = async (role: Role | null): Promise<Record<string, string>> => (role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {});
/** A request that gets past the gate and the validator reaches a handler that needs a database; depending on what an earlier test file left in DATABASE_URL that either fails fast or HANGS. A hang is proof it got there, so after 1 s it counts as «599». */
const settle = (p: Response | Promise<Response>): Promise<Response> => Promise.race([p, new Promise<Response>((res) => setTimeout(() => res(new Response("handler reached, still waiting for the database", { status: 599 })), 1000))]);
const send = async (method: string, path: string, role: Role | null, body?: unknown) =>
  settle(app().request(`/stock${path}`, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(await tokenHeader(role)) } as Record<string, string>, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
const reached = (s: number) => ![400, 401, 403].includes(s);
/** The 400 came from the route's VALIDATOR (zod's own body), not from a later rule in the service that happens to say the same thing. */
const zodRefused = async (res: Response) => res.status === 400 && (await res.clone().json() as { success?: boolean }).success === false;
const RC = "22222222-2222-4222-8222-222222222222";
const PRODUCT = { code: "C-1", name: "Helmet", category: "Miller", priceSatang: 150_000, commissionGroup: null, active: true, openingQuantity: 5, revenueCategoryId: RC };

describe("the four reads — ceo + admin", () => {
  test("no token 401, a coach 403; the CEO and an admin reach the handler (products, revenue-categories, low-stock, low-stock/thresholds)", async () => {
    for (const path of ["/products", "/revenue-categories", "/low-stock", "/low-stock/thresholds"]) {
      expect([path, (await send("GET", path, null)).status]).toEqual([path, 401]);
      expect([path, (await send("GET", path, "coach")).status]).toEqual([path, 403]);
      for (const role of ["admin", "ceo"] as Role[]) expect([path, role, reached((await send("GET", path, role)).status)]).toEqual([path, role, true]);
    }
  });
  test("/products?q= : a search term over 100 characters is a 400; a normal one and exactly 100 pass", async () => {
    expect(await zodRefused(await send("GET", `/products?q=${"x".repeat(101)}`, "admin"))).toBe(true);
    expect(reached((await send("GET", "/products?q=helmet", "admin")).status)).toBe(true);
    expect(reached((await send("GET", `/products?q=${"x".repeat(100)}`, "admin")).status)).toBe(true);
  });
});

describe("POST /stock/products — CEO only; every field validated", () => {
  test("a valid body (also a null category, a commission group, inactive, opening 0) reaches the handler for the CEO", async () => {
    expect(reached((await send("POST", "/products", "ceo", PRODUCT)).status)).toBe(true);
    expect(reached((await send("POST", "/products", "ceo", { ...PRODUCT, category: null, commissionGroup: "Skate bag", active: false, openingQuantity: 0 })).status)).toBe(true);
  });
  test("no token 401; an admin and a coach 403", async () => {
    expect((await send("POST", "/products", null, PRODUCT)).status).toBe(401);
    expect((await send("POST", "/products", "admin", PRODUCT)).status).toBe(403);
    expect((await send("POST", "/products", "coach", PRODUCT)).status).toBe(403);
  });
  test("🔑 every bad field is a 400", async () => {
    const { revenueCategoryId: _drop, ...noCategory } = PRODUCT;
    const bad: Array<[string, unknown]> = [
      ["no body", {}],
      ["code empty", { ...PRODUCT, code: "" }], ["code long", { ...PRODUCT, code: "x".repeat(65) }], ["name empty", { ...PRODUCT, name: "" }], ["name long", { ...PRODUCT, name: "x".repeat(201) }],
      ["price negative", { ...PRODUCT, priceSatang: -1 }], ["price fractional", { ...PRODUCT, priceSatang: 1.5 }], ["price huge", { ...PRODUCT, priceSatang: 1_000_000_001 }], ["price text", { ...PRODUCT, priceSatang: "150000" }],
      ["opening negative", { ...PRODUCT, openingQuantity: -1 }], ["opening fractional", { ...PRODUCT, openingQuantity: 1.5 }], ["opening huge", { ...PRODUCT, openingQuantity: 1_000_001 }],
      ["category long", { ...PRODUCT, category: "x".repeat(101) }], ["group long", { ...PRODUCT, commissionGroup: "x".repeat(101) }],
      ["revenue category missing", noCategory], ["revenue category not a uuid", { ...PRODUCT, revenueCategoryId: "nope" }],
      ["active text", { ...PRODUCT, active: "yes" }],
    ];
    for (const [what, body] of bad) expect([what, await zodRefused(await send("POST", "/products", "ceo", body))]).toEqual([what, true]);
  });
});

describe("PATCH /stock/products/:id — CEO only; the id and every field validated", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  test("a valid partial edit reaches the handler for the CEO; an EMPTY edit passes the validator but is the service's 400 («no fields to edit» — correct, not a validator gap)", async () => {
    expect(reached((await send("PATCH", `/products/${ID}`, "ceo", { name: "New", priceSatang: 100, category: null, commissionGroup: "G", active: false, revenueCategoryId: RC })).status)).toBe(true);
    expect(reached((await send("PATCH", `/products/${ID}`, "ceo", { name: "Only a name" })).status)).toBe(true);
    const empty = await send("PATCH", `/products/${ID}`, "ceo", {});
    expect(empty.status).toBe(400);
    expect(JSON.stringify(await empty.json())).toContain("VALIDATION");
  });
  test("no token 401; an admin and a coach 403", async () => {
    expect((await send("PATCH", `/products/${ID}`, null, { name: "x" })).status).toBe(401);
    expect((await send("PATCH", `/products/${ID}`, "admin", { name: "x" })).status).toBe(403);
    expect((await send("PATCH", `/products/${ID}`, "coach", { name: "x" })).status).toBe(403);
  });
  test("a malformed id is a 400 (never a database error)", async () => {
    for (const id of ["nope", "123", "3333333333333333333333333333333333333"]) expect([id, (await send("PATCH", `/products/${id}`, "ceo", { name: "x" })).status]).toEqual([id, 400]);
  });
  test("🔑 every bad field is a 400 — and a revenue category can NOT be cleared (null)", async () => {
    for (const body of [{ name: "" }, { name: "x".repeat(201) }, { priceSatang: -1 }, { priceSatang: 1.5 }, { active: "no" }, { revenueCategoryId: "nope" }, { revenueCategoryId: null }, { category: "x".repeat(101) }]) {
      expect([JSON.stringify(body), await zodRefused(await send("PATCH", `/products/${ID}`, "ceo", body))]).toEqual([JSON.stringify(body), true]);
    }
  });
});

describe("POST /stock/import/preview — CEO only; the upload is validated before any read", () => {
  const upload = async (role: Role | null, form: FormData | null, extra: Record<string, string> = {}) =>
    settle(app().request("/stock/import/preview", { method: "POST", headers: { ...extra, ...(await tokenHeader(role)) }, ...(form ? { body: form } : {}) }));
  const fileOf = (bytes: Uint8Array | string, name = "stock.xlsx") => { const f = new FormData(); f.set("file", new File([bytes], name)); return f; };

  test("no token 401; an admin and a coach 403", async () => {
    expect((await upload(null, fileOf("x"))).status).toBe(401);
    expect((await upload("admin", fileOf("x"))).status).toBe(403);
    expect((await upload("coach", fileOf("x"))).status).toBe(403);
  });
  test("🔑 400s before any database: no body, JSON instead of multipart, no «file» field, the field is text, an empty file, a non-xlsx file, a broken zip", async () => {
    expect((await upload("ceo", null)).status).toBe(400);
    expect((await send("POST", "/import/preview", "ceo", { file: "x" })).status).toBe(400);
    const noFile = new FormData(); noFile.set("other", "x");
    expect((await upload("ceo", noFile)).status).toBe(400);
    const text = new FormData(); text.set("file", "just text");
    expect((await upload("ceo", text)).status).toBe(400);
    expect((await upload("ceo", fileOf(new Uint8Array(0)))).status).toBe(400);
    expect((await upload("ceo", fileOf("a,b\n1,2", "stock.csv"))).status).toBe(400);
    expect((await upload("ceo", fileOf(new Uint8Array([0x50, 0x4b, 1, 2, 3, 4])))).status).toBe(400);
  });
  test("an upload over 5 MB is a 400, by the declared length and by the real size", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big[0] = 0x50; big[1] = 0x4b;
    expect((await upload("ceo", fileOf(big))).status).toBe(400);
    const declared = await upload("ceo", fileOf("x"), { "content-length": String(6 * 1024 * 1024) });
    expect(declared.status).toBe(400);
    expect(JSON.stringify(await declared.json())).toContain("5 MB"); // the route's own declared-length check (a 1-byte file would otherwise fail later for another reason)
  });
  test("a real .xlsx passes the upload checks and is read (it then needs the database: anything but 400 / 401 / 403)", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Balance Stock");
    ws.addRow(["Model Code", "Name", "Balance"]);
    ws.addRow(["A", "n", 1]);
    expect(reached((await upload("ceo", fileOf(new Uint8Array(await wb.xlsx.writeBuffer())))).status)).toBe(true);
  });
  test("a workbook with bad rows (an empty Model code, a negative balance) is a 400 — still before any database", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Balance Stock");
    ws.addRow(["Model Code", "Name", "Balance"]);
    ws.addRow(["", "n", -3]);
    expect((await upload("ceo", fileOf(new Uint8Array(await wb.xlsx.writeBuffer())))).status).toBe(400);
  });
});
