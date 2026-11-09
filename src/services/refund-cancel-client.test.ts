import { describe, expect, test } from "bun:test";
import { callRefundCancel } from "./refund-cancel-client";

// TASK-893 — the call to smart-scheduler-back's POST /internal/refund-cancel (TASK-892). The fetch is injected: no network.
const ENV = { SCHEDULER_API_URL: "http://sb.test:4306/", SCHEDULER_INTERNAL_SECRET: "s3cret" };
const ID = "11111111-1111-4111-8111-111111111111";
const input = { refType: "COURSE" as const, refId: ID, actor: "u1" };
const reply = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const spy = () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify({ cancelledSessions: 4, alreadyCancelled: false }), { status: 200 }))) as unknown as typeof fetch;
  return { f, calls };
};

describe("callRefundCancel — configuration", () => {
  test.each([
    ["no URL", { SCHEDULER_INTERNAL_SECRET: "s" }],
    ["no secret", { SCHEDULER_API_URL: "http://x" }],
    ["a blank URL", { SCHEDULER_API_URL: "  ", SCHEDULER_INTERNAL_SECRET: "s" }],
    ["a blank secret", { SCHEDULER_API_URL: "http://x", SCHEDULER_INTERNAL_SECRET: "   " }],
    ["neither", {}],
  ])("%s ⇒ NOT_CONFIGURED and NO request", async (_n, env) => {
    const s = spy();
    expect(await callRefundCancel(input, env, s.f)).toBe("NOT_CONFIGURED");
    expect(s.calls).toHaveLength(0);
  });
  test("the SPEC's other name for the secret (INTERNAL_JOB_SECRET) is NOT read on this side: BB's key is SCHEDULER_INTERNAL_SECRET", async () => {
    const s = spy();
    expect(await callRefundCancel(input, { SCHEDULER_API_URL: "http://x", INTERNAL_JOB_SECRET: "s" }, s.f)).toBe("NOT_CONFIGURED");
    expect(s.calls).toHaveLength(0);
  });
});

describe("callRefundCancel — the request", () => {
  test("POST {url}/internal/refund-cancel (one trailing slash trimmed), the secret header, a JSON body of exactly refType / refId / actor, a 5 s timeout signal", async () => {
    const s = spy();
    await callRefundCancel(input, ENV, s.f);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe("http://sb.test:4306/internal/refund-cancel");
    expect(s.calls[0].init.method).toBe("POST");
    expect(s.calls[0].init.headers).toEqual({ "content-type": "application/json", "x-internal-secret": "s3cret" });
    expect(JSON.parse(String(s.calls[0].init.body))).toEqual({ refType: "COURSE", refId: ID, actor: "u1" });
    expect(s.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
  test("a VOUCHER is sent as VOUCHER; no actor ⇒ the key is left out (SB's actor is optional)", async () => {
    const s = spy();
    await callRefundCancel({ refType: "VOUCHER", refId: ID, actor: null }, ENV, s.f);
    expect(JSON.parse(String(s.calls[0].init.body))).toEqual({ refType: "VOUCHER", refId: ID });
  });
});

describe("callRefundCancel — the timeout", () => {
  test("the request is bounded at 5 seconds (a source pin: the timeout cannot be exercised for real in a unit test)", async () => {
    const src = (await Bun.file(new URL("./refund-cancel-client.ts", import.meta.url)).text()).replace(/\/\/.*$/gm, "");
    expect(src).toContain("AbortSignal.timeout(5000)");
  });
});

describe("callRefundCancel — the answers", () => {
  test("200 with the contract body ⇒ the result as is", async () => {
    expect(await callRefundCancel(input, ENV, reply(200, { cancelledSessions: 4, alreadyCancelled: false }))).toEqual({ cancelledSessions: 4, alreadyCancelled: false });
    expect(await callRefundCancel(input, ENV, reply(200, { cancelledSessions: 0, alreadyCancelled: true }))).toEqual({ cancelledSessions: 0, alreadyCancelled: true });
  });
  test.each([
    ["a 404 (unknown plan)", reply(404, { error: { code: "NOT_FOUND" } })],
    ["a 401 (wrong secret)", reply(401, { error: { code: "UNAUTHORIZED" } })],
    ["a 500", reply(500, "boom")],
    ["a 201", reply(201, { cancelledSessions: 1, alreadyCancelled: false })],
    ["a 200 that is not JSON", reply(200, "<html>")],
    ["a 200 with no count", reply(200, { alreadyCancelled: false })],
    ["a 200 with a negative count", reply(200, { cancelledSessions: -1, alreadyCancelled: false })],
    ["a 200 with a fractional count", reply(200, { cancelledSessions: 1.5, alreadyCancelled: false })],
    ["a 200 with a string count", reply(200, { cancelledSessions: "4", alreadyCancelled: false })],
    ["a 200 with no flag", reply(200, { cancelledSessions: 4 })],
    ["a 200 with a string flag", reply(200, { cancelledSessions: 4, alreadyCancelled: "false" })],
    ["a 200 null body", reply(200, "null")],
    ["a 200 array body", reply(200, "[]")],
  ])("%s ⇒ FAILED", async (_n, f) => {
    expect(await callRefundCancel(input, ENV, f)).toBe("FAILED");
  });
  test("a network error and a timeout ⇒ FAILED, never a throw", async () => {
    const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await callRefundCancel(input, ENV, boom)).toBe("FAILED");
    const timeout = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    expect(await callRefundCancel(input, ENV, timeout)).toBe("FAILED");
  });
});
