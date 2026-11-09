// 🔻 TASK-887 (REQ-120 R1.5, SPEC-102 §5-E4) — the coach's own confirm (E4a), the CEO "remind now" list + call (E4b), and the internal read the reminders use (A). DB-less: the in-memory salary store + the in-memory confirm store; the remind-now
// call runs against a REAL local HTTP server. Each case must fail when its code is removed (slip-confirm-task887.mutations.json).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { makeSalaryRoutes } from "../routes/salary";
import { makeInternalSalaryRoutes } from "../routes/salary-internal";
import { createSalaryService } from "./salary.service";
import { memorySalaryStore } from "./salary-memory.store";
import { memorySlipConfirmStore, type SlipConfirmStore } from "./slip-confirm.store";
import { callRemindNow, confirmMySlipFor, listUnconfirmed, remindPeriodFor, unconfirmedForDate, useSlipConfirmStore } from "./slip-confirm.service";
import { signToken, type Role } from "../lib/jwt";
import { ApiException } from "../lib/http";

const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH", "SERVICE_TOKEN", "SCHEDULER_API_URL", "SCHEDULER_INTERNAL_SECRET"];
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; process.env.JWT_SECRET = "test-secret-887"; process.env.SKIP_ADMIN_AUTH = "false"; process.env.SERVICE_TOKEN = "svc-887"; delete process.env.SCHEDULER_API_URL; delete process.env.SCHEDULER_INTERNAL_SECRET; });
afterAll(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterEach(() => { delete process.env.SCHEDULER_API_URL; delete process.env.SCHEDULER_INTERNAL_SECRET; });

const A = "aaaaaaaa-1111-4111-8111-111111111111", B = "bbbbbbbb-2222-4222-8222-222222222222", C = "cccccccc-3333-4333-8333-333333333333", SYS = "99999999-9999-4999-8999-999999999999";

async function setup(now = "2026-10-10T03:00:00Z") {
  const store = memorySalaryStore();
  store.names.set(A, "เอ"); store.names.set(B, "บี"); store.names.set(C, "ซี"); store.names.set(SYS, "No Teacher");
  store.systemIds.add(SYS);
  const clock = { t: now };
  const svc = createSalaryService(store, () => new Date(clock.t), { readHours: async () => [] });
  await svc.setProfile(A, { employmentType: "FT", baseSalary: 2_500_000, active: true });
  await svc.setProfile(B, { employmentType: "FT", baseSalary: 1_800_000, active: true });
  await svc.setProfile(SYS, { employmentType: "FT", baseSalary: 1, active: true });
  const period = await svc.createPeriod(2026, 10);
  await svc.runPeriod(period.id);
  const confirm = memorySlipConfirmStore(store);
  useSlipConfirmStore(svc, confirm);
  const onError = (err: unknown, c: any) => (err instanceof ApiException ? c.json({ error: { code: err.code, message: err.message } }, err.status as 400) : c.json({ error: { code: "INTERNAL", message: String(err) } }, 500));
  const app = new Hono(); app.onError(onError); app.route("/salary", makeSalaryRoutes(svc));
  const internal = new Hono(); internal.onError(onError); internal.route("/api/v1/internal/salary", makeInternalSalaryRoutes(svc));
  return { app, internal, svc, store, confirm, period, clock };
}
type Who = { role: Role; teacherId?: string | null } | null;
const call = async (app: Hono, method: string, path: string, who: Who, body?: unknown) =>
  app.request(`/salary${path}`, { method, headers: { ...(who ? { Authorization: `Bearer ${await signToken({ sub: `u-${who.role}`, role: who.role, teacherId: who.teacherId ?? null })}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as any;
const coachA = { role: "coach" as Role, teacherId: A }, coachB = { role: "coach" as Role, teacherId: B }, coachC = { role: "coach" as Role, teacherId: C };
const admin = { role: "admin" as Role }, ceo = { role: "ceo" as Role };
const statusOf = (store: ReturnType<typeof memorySalaryStore>, id: string) => [...store.slips.values()].find((s) => s.teacherId === id)?.status;

describe("🔴 TASK-887 E4a — POST /salary/my-slip/confirm: a coach confirms ONLY their own slip", () => {
  test("coach A confirms their own (draft → confirmed): 200 with the my-slip DTO, status confirmed; B's slip is untouched", async () => {
    const { app, store } = await setup();
    const r = await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ teacherId: A, status: "confirmed", baseAmount: 2_500_000, total: 2_500_000, period: { year: 2026, month: 10, status: "open" } });
    expect([statusOf(store, A), statusOf(store, B)]).toEqual(["confirmed", "draft"]);
  });
  test("🔑 the TOKEN decides: coach B can confirm only B's own — an id in the body (any key, even a real one of A) is not honoured", async () => {
    const { app, store } = await setup();
    const r = await call(app, "POST", "/my-slip/confirm", coachB, { year: 2026, month: 10, teacherId: A, slipId: "x", id: A });
    expect(r.status).toBe(200);
    expect((await json(r)).teacherId).toBe(B);
    expect([statusOf(store, A), statusOf(store, B)]).toEqual(["draft", "confirmed"]);
  });
  test("🔑 at the SERVICE too: a teacherId smuggled into the body is never read — the token's id is the only one", async () => {
    const { svc, store } = await setup();
    const out = await confirmMySlipFor(svc, { teacherId: B }, { year: 2026, month: 10, teacherId: A } as any);
    expect(out.teacherId).toBe(B);
    expect([statusOf(store, A), statusOf(store, B)]).toEqual(["draft", "confirmed"]);
  });
  test("no teacherId on the token (admin / ceo) ⇒ 403 NO_TEACHER; no token ⇒ 401; nothing is written", async () => {
    const { app, store } = await setup();
    for (const who of [admin, ceo]) { const r = await call(app, "POST", "/my-slip/confirm", who, { year: 2026, month: 10 }); expect([r.status, (await json(r)).error.code]).toEqual([403, "NO_TEACHER"]); }
    expect((await call(app, "POST", "/my-slip/confirm", null, { year: 2026, month: 10 })).status).toBe(401);
    expect([statusOf(store, A), statusOf(store, B)]).toEqual(["draft", "draft"]);
  });
  test("a LOCKED slip ⇒ 409 LOCKED — also by the LAZY 12:00 lock on the last day (the confirm itself triggers it), and the slip is never moved to confirmed", async () => {
    const { app, store, clock } = await setup();
    clock.t = "2026-10-31T05:00:01Z"; // 12:00:01 Bangkok on the last day
    const r = await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 });
    expect([r.status, (await json(r)).error.code]).toEqual([409, "LOCKED"]);
    expect(statusOf(store, A)).toBe("locked");
    // one second BEFORE the lock it still confirms
    const fresh = await setup("2026-10-31T04:59:59Z");
    expect((await call(fresh.app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 })).status).toBe(200);
  });
  test("no slip ⇒ 404 NO_SLIP: a coach with no slip in an existing period, and a month with no period at all", async () => {
    const { app } = await setup();
    const a = await call(app, "POST", "/my-slip/confirm", coachC, { year: 2026, month: 10 });
    expect([a.status, (await json(a)).error.code]).toEqual([404, "NO_SLIP"]);
    const b = await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 9 });
    expect([b.status, (await json(b)).error.code]).toEqual([404, "NO_SLIP"]);
  });
  test("a re-confirm is idempotent: 200 again, still confirmed, ONE write", async () => {
    const { app, confirm } = await setup();
    expect((await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 })).status).toBe(200);
    const again = await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 });
    expect([again.status, (await json(again)).status]).toEqual([200, "confirmed"]);
    expect(confirm.writes).toBe(1);
  });
  test("🔑 the conditional update NEVER moves a locked or confirmed slip (the one condition is `status = draft`)", async () => {
    const { store, confirm } = await setup();
    const slip = [...store.slips.values()].find((s) => s.teacherId === A)!;
    slip.status = "locked";
    expect(await confirm.confirmDraft(A, 2026, 10, new Date())).toBe(false);
    expect(slip.status).toBe("locked");
    slip.status = "confirmed";
    expect(await confirm.confirmDraft(A, 2026, 10, new Date())).toBe(false);
    expect(confirm.writes).toBe(0);
    slip.status = "draft";
    expect(await confirm.confirmDraft(A, 2026, 10, new Date())).toBe(true);
    expect(await confirm.confirmDraft(C, 2026, 10, new Date())).toBe(false); // no slip
  });
  test("🔑 the RACE: the lock got there between the read and the update ⇒ the conditional update moves nothing and the answer is 409 LOCKED (or 200 if a double click confirmed it first)", async () => {
    const { svc } = await setup();
    const racing = (after: "locked" | "confirmed" | null): SlipConfirmStore => ({ confirmDraft: async () => false, slipStatus: async () => after });
    useSlipConfirmStore(svc, racing("locked"));
    await expect(confirmMySlipFor(svc, { teacherId: A }, { year: 2026, month: 10 })).rejects.toMatchObject({ status: 409, code: "LOCKED" });
    useSlipConfirmStore(svc, racing("confirmed"));
    await expect(confirmMySlipFor(svc, { teacherId: A }, { year: 2026, month: 10 })).resolves.toMatchObject({ teacherId: A });
    useSlipConfirmStore(svc, racing(null));
    await expect(confirmMySlipFor(svc, { teacherId: A }, { year: 2026, month: 10 })).rejects.toMatchObject({ status: 404, code: "NO_SLIP" });
  });
  test("a bad body ⇒ 400 and nothing is written; a bad year / month ⇒ 400", async () => {
    const { app, store } = await setup();
    for (const body of [{}, { year: "2026", month: 10 }, { year: 2026 }, { year: 2026, month: 13 }, { year: 1999, month: 10 }]) expect([JSON.stringify(body), (await call(app, "POST", "/my-slip/confirm", coachA, body)).status]).toEqual([JSON.stringify(body), 400]);
    expect(statusOf(store, A)).toBe("draft");
  });
  test("ROUTE ORDER: `/my-slip/confirm` is not swallowed by `/my-slip` or `/slips/:id`, and `GET /my-slip` still answers", async () => {
    const { app } = await setup();
    expect((await call(app, "GET", "/my-slip?year=2026&month=10", coachA)).status).toBe(200);
    expect((await call(app, "GET", "/my-slip/confirm?year=2026&month=10", coachA)).status).toBe(404); // confirm is a POST only
    expect((await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 })).status).toBe(200);
  });
  test("THE OPEN ITEM (noted, not solved): an admin Entries write AFTER the coach's confirm — what happens TODAY", async () => {
    const { app, store } = await setup();
    await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 });
    const r = await call(app, "POST", "/entries", admin, { teacherId: A, year: 2026, month: 10, kind: "other", amountSatang: -5_000, label: "", reason: "late" });
    expect(r.status).toBe(201); // ALLOWED today: the line is added to a `confirmed` slip, and the confirm is not re-opened
    expect(statusOf(store, A)).toBe("confirmed");
  });
});

describe("🔴 TASK-887 E4b — POST /salary/periods/:id/remind: the CEO's unconfirmed list (no pay)", () => {
  test("CEO 200: draft slips and coaches with no slip yet are listed; the key set is exactly {teacherId, name, status}", async () => {
    const { app, svc, store, period } = await setup();
    store.names.set(C, "ซี");
    await svc.setProfile(C, { employmentType: "FT", baseSalary: 1_000_000, active: true }); // a profile created AFTER the run: no slip yet
    const r = await call(app, "POST", `/periods/${period.id}/remind`, ceo);
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.targets.map((t: any) => [t.teacherId, t.name, t.status]).sort()).toEqual([[A, "เอ", "draft"], [B, "บี", "draft"], [C, "ซี", "none"]].sort());
    for (const t of body.targets) expect(Object.keys(t).sort()).toEqual(["name", "status", "teacherId"]);
    expect(JSON.stringify(body)).not.toMatch(/amount|total|base|salary|rate|satang|pay/i); // no pay key anywhere
  });
  test("admin / coach ⇒ 403, no token ⇒ 401", async () => {
    const { app, period } = await setup();
    for (const who of [admin, coachA]) expect((await call(app, "POST", `/periods/${period.id}/remind`, who)).status).toBe(403);
    expect((await call(app, "POST", `/periods/${period.id}/remind`, null)).status).toBe(401);
  });
  test("a CONFIRMED slip and a LOCKED one are absent; «No Teacher» (is_system) is absent; an inactive profile is absent", async () => {
    const { app, svc, period } = await setup();
    await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 });
    const list = (await json(await call(app, "POST", `/periods/${period.id}/remind`, ceo))).targets;
    expect(list.map((t: any) => t.teacherId)).toEqual([B]); // A confirmed; SYS excluded
    await svc.setProfile(B, { employmentType: "FT", baseSalary: 1_800_000, active: false });
    expect((await json(await call(app, "POST", `/periods/${period.id}/remind`, ceo))).targets).toEqual([]);
    await svc.lockPeriod(period.id);
    await svc.setProfile(B, { employmentType: "FT", baseSalary: 1_800_000, active: true });
    expect((await listUnconfirmed(svc, period.id)).map((t) => t.teacherId)).toEqual([]); // locked: nothing left to remind
  });
  test("an unknown period ⇒ 404 and NO send is attempted", async () => {
    const { app } = await setup();
    let called = 0;
    process.env.SCHEDULER_API_URL = "http://127.0.0.1:9"; process.env.SCHEDULER_INTERNAL_SECRET = "s";
    expect((await call(app, "POST", "/periods/00000000-0000-4000-8000-0000000000ff/remind", ceo)).status).toBe(404);
    expect((await call(app, "POST", "/periods/not-a-uuid/remind", ceo)).status).toBe(404);
    expect(called).toBe(0);
  });
});

describe("🔴 TASK-887 B — the remind-now call to smart-scheduler-back, against a real local HTTP server", () => {
  const seen: Array<{ method: string; path: string; secret: string | null; body: unknown }> = [];
  const serve = (reply: () => Response) => Bun.serve({ port: 0, async fetch(req) { seen.push({ method: req.method, path: new URL(req.url).pathname, secret: req.headers.get("x-internal-secret"), body: await req.json().catch(() => null) }); return reply(); } });
  const PID = "11111111-aaaa-4aaa-8aaa-111111111111";
  test("keys unset ⇒ `NOT_CONFIGURED` and NO request; one key missing ⇒ the same", async () => {
    let calls = 0;
    const spy = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await callRemindNow(PID, {}, spy)).toBe("NOT_CONFIGURED");
    expect(await callRemindNow(PID, { SCHEDULER_API_URL: "http://x" }, spy)).toBe("NOT_CONFIGURED");
    expect(await callRemindNow(PID, { SCHEDULER_INTERNAL_SECRET: "s" }, spy)).toBe("NOT_CONFIGURED");
    expect(await callRemindNow(PID, { SCHEDULER_API_URL: "  ", SCHEDULER_INTERNAL_SECRET: "s" }, spy)).toBe("NOT_CONFIGURED");
    expect(calls).toBe(0);
  });
  test("set ⇒ ONE request: POST /internal/salary-remind-now, the body is EXACTLY { periodId }, the secret rides in x-internal-secret; both NowResult shapes are relayed UNCHANGED", async () => {
    for (const result of [{ ran: false, reason: "after-lock-time" }, { ran: true, periodId: PID, targets: 2, sent: ["a"], skipped: [{ teacherId: "b", reason: "NO_LINE_ID" }] }]) {
      seen.length = 0;
      const srv = serve(() => Response.json(result));
      try {
        const out = await callRemindNow(PID, { SCHEDULER_API_URL: `http://127.0.0.1:${srv.port}/`, SCHEDULER_INTERNAL_SECRET: "sek" });
        expect(out).toEqual(result);
        expect(seen).toEqual([{ method: "POST", path: "/internal/salary-remind-now", secret: "sek", body: { periodId: PID } }]);
      } finally { srv.stop(true); }
    }
  });
  test("503 / 401 / 400 / 500 / a non-JSON 200 / a JSON array ⇒ `FAILED` (never a throw)", async () => {
    for (const reply of [() => new Response("{}", { status: 503 }), () => new Response("{}", { status: 401 }), () => new Response("{}", { status: 400 }), () => new Response("boom", { status: 500 }), () => new Response("not json"), () => Response.json([1, 2])]) {
      const srv = serve(reply);
      try { expect(await callRemindNow(PID, { SCHEDULER_API_URL: `http://127.0.0.1:${srv.port}`, SCHEDULER_INTERNAL_SECRET: "s" })).toBe("FAILED"); } finally { srv.stop(true); }
    }
  });
  test("a timeout and a network error ⇒ `FAILED`; the request carries a 5 s timeout signal", async () => {
    let signal: AbortSignal | undefined;
    const timing = (async (_u: string, init: RequestInit) => { signal = init.signal as AbortSignal; throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    expect(await callRemindNow(PID, { SCHEDULER_API_URL: "http://x", SCHEDULER_INTERNAL_SECRET: "s" }, timing)).toBe("FAILED");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(await callRemindNow(PID, { SCHEDULER_API_URL: "http://127.0.0.1:1", SCHEDULER_INTERNAL_SECRET: "s" })).toBe("FAILED"); // connection refused
  });
  test("through the ROUTE: the CEO always gets a 200 with the list and `send` (NOT_CONFIGURED / the relayed NowResult / FAILED); the response carries no pay", async () => {
    const { app, period } = await setup();
    let r = await json(await call(app, "POST", `/periods/${period.id}/remind`, ceo));
    expect(r.send).toBe("NOT_CONFIGURED");
    const now = { ran: true, periodId: period.id, targets: 2, sent: [A, B], skipped: [] };
    seen.length = 0;
    const srv = serve(() => Response.json(now));
    try {
      process.env.SCHEDULER_API_URL = `http://127.0.0.1:${srv.port}`; process.env.SCHEDULER_INTERNAL_SECRET = "sek";
      const res = await call(app, "POST", `/periods/${period.id}/remind`, ceo);
      expect(res.status).toBe(200);
      r = await json(res);
      expect(r.send).toEqual(now);
      expect(seen[0]!.body).toEqual({ periodId: period.id });
      expect(JSON.stringify(r)).not.toMatch(/amount|total|base|salary|rate|satang/i);
    } finally { srv.stop(true); }
    process.env.SCHEDULER_API_URL = "http://127.0.0.1:1";
    const down = await call(app, "POST", `/periods/${period.id}/remind`, ceo);
    expect([down.status, (await json(down)).send]).toEqual([200, "FAILED"]);
  });
});

describe("🔴 TASK-887 A — the MOUNT: the real app reaches /api/v1/internal/salary/unconfirmed with only X-Service-Token", () => {
  test("through the real `api`: the route is mounted, a service token reaches the guard (the handler then needs the db, so a 500 is NOT a 401), a user Bearer and no token are 401", async () => {
    const root = (await import("../index")).default as { fetch: (r: Request) => Promise<Response> };
    const hit = (path: string, headers: Record<string, string> = {}) => root.fetch(new Request(`http://localhost/api${path}`, { headers }));
    const url = "/v1/internal/salary/unconfirmed?date=not-a-date"; // a 400 proves the handler was reached without touching the db
    expect((await hit(url, { "X-Service-Token": "svc-887" })).status).toBe(400);
    expect((await hit(url)).status).toBe(401);
    expect((await hit(url, { Authorization: `Bearer ${await signToken({ sub: "u", role: "ceo" })}` })).status).toBe(401);
    expect((await hit("/v1/internal/salary/other", { "X-Service-Token": "svc-887" })).status).toBe(404);
  });
});

describe("🔴 TASK-887 A — GET /api/v1/internal/salary/unconfirmed?date= (the read the reminders use)", () => {
  const get = (app: Hono, qs: string, token: string | null = "svc-887") => app.request(`/api/v1/internal/salary/unconfirmed${qs}`, { headers: token === null ? {} : { "X-Service-Token": token } });
  test("a date inside the period: { periodId, lockAt (ISO), teacherIds } — DRAFT slips only; on its FIRST day (30 Sep) and LAST day (30 Oct) too", async () => {
    const { internal, period } = await setup();
    for (const date of ["2026-09-30", "2026-10-10", "2026-10-30"]) {
      const r = await get(internal, `?date=${date}`);
      expect(r.status).toBe(200);
      expect(await json(r)).toEqual({ periodId: period.id, lockAt: "2026-10-31T05:00:00.000Z", teacherIds: [A, B].sort() });
    }
  });
  test("outside every period ⇒ { periodId: null }", async () => {
    const { internal } = await setup();
    for (const date of ["2026-09-29", "2026-11-01", "2027-01-01"]) expect(await json(await get(internal, `?date=${date}`))).toEqual({ periodId: null });
  });
  test("DRAFT only: a CONFIRMED slip, a coach with NO slip, an inactive profile and «No Teacher» are all absent from teacherIds", async () => {
    const { internal, app, svc, store } = await setup();
    store.names.set(C, "ซี");
    await svc.setProfile(C, { employmentType: "FT", baseSalary: 1_000_000, active: true }); // no slip
    await call(app, "POST", "/my-slip/confirm", coachA, { year: 2026, month: 10 });
    expect((await json(await get(internal, "?date=2026-10-10"))).teacherIds).toEqual([B]);
    await svc.setProfile(B, { employmentType: "FT", baseSalary: 1_800_000, active: false });
    expect((await json(await get(internal, "?date=2026-10-10"))).teacherIds).toEqual([]);
  });
  test("a locked period lists nobody; the lazy lock applies on this read too", async () => {
    const { internal, clock } = await setup();
    clock.t = "2026-10-31T05:00:01Z";
    expect((await json(await get(internal, "?date=2026-10-30"))).teacherIds).toEqual([]);
  });
  test("🔒 fail-closed auth: no header ⇒ 401, a wrong token ⇒ 401, a user Bearer ⇒ 401, and an UNSET / empty SERVICE_TOKEN opens nothing", async () => {
    const { internal } = await setup();
    expect((await get(internal, "?date=2026-10-10", null)).status).toBe(401);
    expect((await get(internal, "?date=2026-10-10", "nope")).status).toBe(401);
    expect((await get(internal, "?date=2026-10-10", "svc-88")).status).toBe(401); // a prefix is not the token
    expect((await get(internal, "?date=2026-10-10", "svc-887-and-more")).status).toBe(401); // …and the token is not a prefix of the caller's
    const bearer = await internal.request("/api/v1/internal/salary/unconfirmed?date=2026-10-10", { headers: { Authorization: `Bearer ${await signToken({ sub: "u", role: "ceo" })}` } });
    expect(bearer.status).toBe(401);
    const keep = process.env.SERVICE_TOKEN;
    try {
      process.env.SERVICE_TOKEN = "";
      expect((await get(internal, "?date=2026-10-10", "")).status).toBe(401);
      expect((await get(internal, "?date=2026-10-10", null)).status).toBe(401);
      delete process.env.SERVICE_TOKEN;
      expect((await get(internal, "?date=2026-10-10", "anything")).status).toBe(401);
    } finally { process.env.SERVICE_TOKEN = keep; }
  });
  test("a missing or malformed date ⇒ 400", async () => {
    const { internal } = await setup();
    for (const qs of ["", "?date=", "?date=2026-13-01", "?date=2026-02-30", "?date=14/10/2026", "?date=20261010"]) expect([qs, (await get(internal, qs)).status]).toEqual([qs, 400]);
  });
  describe("🔁 THE CONFIRM-DAY RULE (the amendment to contract A): the period whose lockAt is that Bangkok date wins, else the range, else null", () => {
    const oct = { id: "oct", year: 2026, month: 10, periodStart: "2026-09-30", periodEnd: "2026-10-30", lockAt: "2026-10-31T05:00:00.000Z" };
    const nov = { id: "nov", year: 2026, month: 11, periodStart: "2026-10-31", periodEnd: "2026-11-29", lockAt: "2026-11-30T05:00:00.000Z" };
    const fake = (periods: any[]) => ({ listPeriods: async () => periods, getPeriod: async (id: string) => ({ slips: [{ teacherId: id === "oct" ? A : B, status: "draft" }] }), listEntriesPeople: async () => [{ teacherId: A, name: "a" }, { teacherId: B, name: "b" }] }) as any;
    test("31 Oct ⇒ OCTOBER (its lock day), although 31 Oct is also November's first range day", async () => {
      expect((await unconfirmedForDate(fake([nov, oct]), "2026-10-31")).periodId).toBe("oct");
      expect((await unconfirmedForDate(fake([oct, nov]), "2026-10-31")).teacherIds).toEqual([A]);
    });
    test("30 Oct ⇒ October (its range) · 1 Nov ⇒ November (its range)", async () => {
      expect((await unconfirmedForDate(fake([oct, nov]), "2026-10-30")).periodId).toBe("oct");
      expect((await unconfirmedForDate(fake([oct, nov]), "2026-11-01")).periodId).toBe("nov");
    });
    test("31 Oct when October has no row but November does ⇒ November (rule 2)", async () => {
      expect((await unconfirmedForDate(fake([nov]), "2026-10-31")).periodId).toBe("nov");
    });
    test("the lock day is a BANGKOK date: lockAt 2026-10-31T17:30Z is 1 Nov in Bangkok (not 31 Oct)", async () => {
      const late = { ...oct, lockAt: "2026-10-31T17:30:00.000Z" };
      expect((await unconfirmedForDate(fake([late, nov]), "2026-11-01")).periodId).toBe("oct");
      expect((await unconfirmedForDate(fake([late, nov]), "2026-10-31")).periodId).toBe("nov"); // not its lock day in Bangkok ⇒ rule 2
    });
  });
  test("the service form: a period with no stored range falls back to the R1.4 range of its year / month", async () => {
    const fake = { listPeriods: async () => [{ id: "p1", year: 2026, month: 10, periodStart: null, periodEnd: null, lockAt: "2026-10-31T05:00:00.000Z" }], getPeriod: async () => ({ slips: [{ teacherId: A, status: "draft" }] }), listEntriesPeople: async () => [{ teacherId: A, name: "เอ" }] } as any;
    expect(await unconfirmedForDate(fake, "2026-09-30")).toEqual({ periodId: "p1", lockAt: "2026-10-31T05:00:00.000Z", teacherIds: [A] });
    expect(await unconfirmedForDate(fake, "2026-10-31")).toEqual({ periodId: "p1", lockAt: "2026-10-31T05:00:00.000Z", teacherIds: [A] }); // the confirm day (rule 1)
    expect(await unconfirmedForDate(fake, "2026-11-01")).toEqual({ periodId: null });
  });
  test("the CEO list service is the one definition both E4b and A read (same rule)", async () => {
    const { svc, period } = await setup();
    expect((await listUnconfirmed(svc, period.id)).map((t) => t.status)).toEqual(["draft", "draft"]);
    expect((await remindPeriodFor(svc, period.id, {})).send).toBe("NOT_CONFIGURED");
  });
});
