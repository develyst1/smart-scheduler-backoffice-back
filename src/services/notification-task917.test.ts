// TASK-917 - notifications (R0.4): the feed is OWN-only, mark-read, the role-derived (read-only) recipients, the producer seam's validation, and the route gates. DB-less.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ApiException } from "../lib/http";
import { signToken, type Role } from "../lib/jwt";
import { NOTIFY_TYPES, isNotifyType, type NotifyType } from "../lib/notification";
import { notificationRoutes } from "../routes/notifications";
import { createNotification, createNotificationService, type AssignmentRow, type FeedItem, type NotificationStore } from "./notification.service";

function memory() {
  const rows: Array<FeedItem & { ref: string }> = [];
  let n = 0;
  const assignments: AssignmentRow[] = [...NOTIFY_TYPES].map((type) => ({ subjectKind: "role" as const, subject: "ceo", type }));
  assignments.push({ subjectKind: "user", subject: "london", type: "Low Stock" });
  const store: NotificationStore = {
    feed: async (ref) => rows.filter((r) => r.ref === ref).map(({ ref: _r, ...i }) => i).sort((a, b) => b.date.localeCompare(a.date)),
    markRead: async (ref, id) => {
      const r = rows.find((x) => x.id === id && x.ref === ref);
      if (r) r.read = true;
      return !!r;
    },
    markAll: async (ref) => {
      const mine = rows.filter((r) => r.ref === ref && !r.read);
      mine.forEach((r) => (r.read = true));
      return mine.length;
    },
    assignments: async () => assignments,
    rolesOf: async (names) => new Map(names.filter((x) => x === "london").map((x) => [x, "admin"])),
    coaches: async () => [{ who: "Pete", type: "Full-time" }],
  };
  const add = (ref: string, type: NotifyType, text: string, date: string) => rows.push({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, ref, type, text, date, read: false });
  return { rows, add, svc: createNotificationService(store, () => new Date("2026-11-09T05:00:00Z")) };
}
const rejects = async (p: Promise<unknown>, status: number) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiException);
    expect((e as ApiException).status).toBe(status);
    return;
  }
  throw new Error("expected a rejection");
};

describe("the feed is OWN-only", () => {
  test("a person sees only their items, newest first, in the 914 shape {id,type,text,date,read}", async () => {
    const m = memory();
    m.add("ceo", "Bonus", "For 50 · Pete", "2026-10-21");
    m.add("ceo", "Low Stock", "Miller helmet — M: 4 left (limit 5)", "2026-10-19");
    m.add("london", "Low Stock", "Water 600 ml: 8 left (limit 10)", "2026-10-19");
    const ceo = await m.svc.feed("CEO"); // the token's sub is matched case-insensitively
    expect(ceo.map((i) => i.type)).toEqual(["Bonus", "Low Stock"]);
    expect(Object.keys(ceo[0]!).sort()).toEqual(["date", "id", "read", "text", "type"]);
    expect((await m.svc.feed("london")).map((i) => i.text)).toEqual(["Water 600 ml: 8 left (limit 10)"]);
    expect(await m.svc.feed("nobody")).toEqual([]);
  });
  test("mark-read marks MY item; someone else's id is 404 (not forbidden: it does not reveal it exists); read-all marks only mine", async () => {
    const m = memory();
    m.add("ceo", "Bonus", "a", "2026-10-21");
    m.add("ceo", "Other", "b", "2026-10-20");
    m.add("london", "Low Stock", "c", "2026-10-19");
    const mine = m.rows[0]!.id;
    const theirs = m.rows[2]!.id;
    await m.svc.markRead("ceo", mine);
    expect(m.rows[0]!.read).toBe(true);
    await rejects(m.svc.markRead("ceo", theirs), 404);
    expect(m.rows[2]!.read).toBe(false);
    expect(await m.svc.markAll("ceo")).toEqual({ marked: 1 });
    expect(m.rows.map((r) => r.read)).toEqual([true, true, false]);
    expect(await m.svc.markAll("ceo")).toEqual({ marked: 0 });
  });
});

describe("recipients (ruling C-h: role-derived, read-only)", () => {
  test("the CEO role gets all seven types; London gets Low Stock; the CEO row first", async () => {
    const m = memory();
    const r = await m.svc.recipients();
    expect(r[0]).toEqual({ who: "CEO", role: "CEO", gets: [...NOTIFY_TYPES] });
    expect(r[1]).toEqual({ who: "london", role: "Admin", gets: ["Low Stock"] });
    expect(r).toHaveLength(2);
  });
  test("the service exposes NO write for assignments or opt-out", () => {
    const m = memory();
    expect(Object.keys(m.svc).sort()).toEqual(["coaches", "feed", "markAll", "markRead", "notifyAssigned", "recipients"]);
  });
  test("coaches", async () => {
    expect(await memory().svc.coaches()).toEqual([{ who: "Pete", type: "Full-time" }]);
  });
});

describe("the producer seam validates before it writes", () => {
  test("createNotification refuses a bad type / empty or long text / bad day / empty recipient, never touching the executor", async () => {
    const ok = { recipientRef: "ceo", type: "Low Stock" as const, text: "x", occurredOn: "2026-11-09", key: "k" };
    await rejects(createNotification(null, { ...ok, type: "Nope" as never }), 400);
    await rejects(createNotification(null, { ...ok, text: "  " }), 400);
    await rejects(createNotification(null, { ...ok, text: "x".repeat(501) }), 400);
    await rejects(createNotification(null, { ...ok, occurredOn: "09/11/2026" }), 400);
    await rejects(createNotification(null, { ...ok, recipientRef: " " }), 400);
  });
  test("the type vocabulary is the seven of the DB check", () => {
    expect([...NOTIFY_TYPES]).toEqual(["Bonus", "Commission", "Transportation", "OT", "Other", "Low Stock", "Extra Hour"]);
    expect(isNotifyType("Low Stock")).toBe(true);
    expect(isNotifyType("Salary")).toBe(false);
  });
});

describe("the routes' gates", () => {
  const KEYS = ["JWT_SECRET", "SKIP_ADMIN_AUTH"];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.JWT_SECRET = "test-secret-917";
    process.env.SKIP_ADMIN_AUTH = "false";
  });
  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const app = new Hono().onError((err, c) => (err instanceof ApiException ? c.json({ error: { code: err.code } }, err.status as 400) : c.json({ error: { code: "INTERNAL" } }, 500))).route("/notifications", notificationRoutes);
  const call = async (method: string, path: string, role: Role | null) =>
    app.request(`/notifications${path}`, { method, headers: role ? { Authorization: `Bearer ${await signToken({ sub: `u-${role}`, role })}` } : {} });
  const ID = "11111111-1111-4111-8111-111111111111";

  test("every route: none 401; the CEO-only ones (recipients, coaches) refuse admin and coach 403", async () => {
    for (const [m, p] of [["GET", ""], ["POST", "/read-all"], ["POST", `/${ID}/read`], ["GET", "/recipients"], ["GET", "/coaches"]] as const) expect([m, p, (await call(m, p, null)).status]).toEqual([m, p, 401]);
    for (const p of ["/recipients", "/coaches"]) {
      expect([p, (await call("GET", p, "admin")).status]).toEqual([p, 403]);
      expect([p, (await call("GET", p, "coach")).status]).toEqual([p, 403]);
    }
  });
  test("mark-read / read-all are for ceo + admin: a coach is 403; a bad id is 400; a coach's feed is an empty list (no database)", async () => {
    expect((await call("POST", `/${ID}/read`, "coach")).status).toBe(403);
    expect((await call("POST", "/read-all", "coach")).status).toBe(403);
    expect((await call("POST", "/not-a-uuid/read", "admin")).status).toBe(400);
    const r = await call("GET", "", "coach");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
  test("there is NO write route for assignments (ruling C-h): PUT / POST / DELETE on recipients are 404 or 405", async () => {
    for (const m of ["PUT", "POST", "PATCH", "DELETE"]) expect([404, 405]).toContain((await call(m, "/recipients", "ceo")).status);
  });
});
