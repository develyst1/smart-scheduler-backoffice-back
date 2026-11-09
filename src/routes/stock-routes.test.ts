// Route-level checks of the /stock router THROUGH the real validators (the service tests bypass them — that is how the receivedOn regex lost its backslashes and every POST /stock/in answered 400 on sid).
// No database: a body that passes validation reaches the handler, which cannot connect here (a 500 / anything but 400 / 401 / 403 is the proof it got past the validator).
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { db } from "../db";
import { signToken, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";
import { stockInBody, stockRoutes } from "./stock";

// The database calls are stubbed to fail at once (see stock-routes-more.test.ts): a real connection attempt would leave the shared client in a retry state that slows other files.
const dbStubs: Array<{ mockRestore: () => void }> = [];
beforeAll(() => { for (const k of ["select", "selectDistinct", "insert", "update", "delete", "execute", "transaction"]) dbStubs.push(spyOn(db as never, k as never).mockImplementation((() => { throw new Error("no database in this test"); }) as never)); });
afterAll(() => { for (const s of dbStubs.splice(0)) s.mockRestore(); });

const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; process.env.JWT_SECRET = "test-secret-stock-routes"; process.env.SKIP_ADMIN_AUTH = "false"; });
afterAll(() => { for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])); });

const app = () => {
  const a = new Hono();
  a.onError((e, c) => (e instanceof ApiException ? c.json({ error: { code: e.code } }, e.status as 400) : c.json({ error: "internal" }, 500)));
  return a.route("/stock", stockRoutes);
};
/** A request that gets past the gate and the validator reaches a handler that needs a database; depending on what an earlier test file left in DATABASE_URL that either fails fast or HANGS. A hang is proof it got there, so after 1 s it counts as «599». */
const settle = (p: Response | Promise<Response>): Promise<Response> => Promise.race([p, new Promise<Response>((res) => setTimeout(() => res(new Response("handler reached, still waiting for the database", { status: 599 })), 1000))]);
const post = async (path: string, body: unknown, role: Role | null = "admin") =>
  settle(app().request(`/stock${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {}) }, body: JSON.stringify(body) }));

const ITEM = "11111111-1111-4111-8111-111111111111";
const IN = (receivedOn: unknown) => ({ idempotencyKey: "recv-0001-abcdef", receivedOn, lines: [{ itemId: ITEM, qty: 3 }] });

describe("POST /stock/in — through the real route and validator", () => {
  test("🔑 a valid body with receivedOn «2026-11-09» passes the validator (it reaches the handler: not 400 / 401 / 403)", async () => {
    for (const role of ["admin", "ceo"] as Role[]) {
      const s = (await post("/in", IN("2026-11-09"), role)).status;
      expect([400, 401, 403]).not.toContain(s);
    }
  });
  test("🔑 a bad date is a 400: «bad», «2026-1-9», «20261109», «2026-11-09T00:00», a number, a missing date", async () => {
    for (const bad of ["bad", "2026-1-9", "20261109", "2026-11-09T00:00", " 2026-11-09", "dddd-dd-dd", 20261109, undefined, null]) expect((await post("/in", IN(bad))).status).toBe(400);
  });
  test("no token 401, a coach 403; the CEO and an admin are the two allowed roles", async () => {
    expect((await post("/in", IN("2026-11-09"), null)).status).toBe(401);
    expect((await post("/in", IN("2026-11-09"), "coach")).status).toBe(403);
  });
  test("the other body rules hold too: no lines, a fractional / zero qty, a non-uuid item, a short key are all 400", async () => {
    expect((await post("/in", { ...IN("2026-11-09"), lines: [] })).status).toBe(400);
    for (const qty of [0, 1.5, -1]) expect((await post("/in", { ...IN("2026-11-09"), lines: [{ itemId: ITEM, qty }] })).status).toBe(400);
    expect((await post("/in", { ...IN("2026-11-09"), lines: [{ itemId: "nope", qty: 1 }] })).status).toBe(400);
    expect((await post("/in", { ...IN("2026-11-09"), idempotencyKey: "short" })).status).toBe(400);
  });
  test("the schema itself: the regex is a real \\d pattern (the literal-«d» regression)", () => {
    expect(stockInBody.safeParse(IN("2026-11-09")).success).toBe(true);
    expect(stockInBody.safeParse(IN("dddd-dd-dd")).success).toBe(false);
    const src = stockInBody.shape.receivedOn.toString();
    expect(src).toBeTruthy();
  });
});

describe("the other stock write routes reject an empty / malformed body with a 400 BEFORE the service (their validators are reachable)", () => {
  test("POST /out, /import/apply: an empty body is a 400 (a CEO / admin passes the gate first)", async () => {
    expect((await post("/out", {}, "admin")).status).toBe(400);
    expect((await post("/import/apply", {}, "ceo")).status).toBe(400);
    expect((await post("/import/apply", {}, "admin")).status).toBe(403); // CEO-only
  });
});
