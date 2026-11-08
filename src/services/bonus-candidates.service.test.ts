import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { ApiException } from "../lib/http";
import { DEFAULT_RULES, monthWindow, type PurchaseRow } from "../lib/bonus-rules";
import { sbBookings, sbCourses, sbStudents, sbSubjects, sbVouchers } from "../db/schema-salary-b-read";
import {
  coursesInMonthQuery,
  firstAttendedByCourseQuery,
  firstAttendedByVoucherQuery,
  listBonusCandidates,
  loadPurchaseRowsFrom,
  vouchersInMonthQuery,
} from "./bonus-candidates.service";

// TASK-863 — the service, DB-free. `postgres()` builds a client LAZILY (no connection until a query runs), so a real
// drizzle instance can render the SQL of a query with `.toSQL()` and nothing ever reaches a database. The assembly of
// plain rows is driven through a fake whose answers are keyed by TABLE (not by call order).

const d = drizzle(postgres("postgres://x:x@localhost:5432/none"));
const W = monthWindow("2026-10"); // 2026-09-30T17:00Z … 2026-10-31T17:00Z

describe("the month window and source = 'SALE' (rendered SQL, no connection)", () => {
  const c = coursesInMonthQuery(d, W).toSQL();
  const v = vouchersInMonthQuery(d, W).toSQL();

  test("courses: from course_packages, source = 'SALE', created_at >= start AND < end (half-open)", () => {
    expect(c.sql).toContain('from "course_packages"');
    expect(c.sql).toContain('"course_packages"."source" = $1');
    expect(c.sql).toContain('"course_packages"."created_at" >= $2');
    expect(c.sql).toContain('"course_packages"."created_at" < $3');
    expect(c.params).toEqual(["SALE", W.start.toISOString(), W.end.toISOString()]);
  });
  test("vouchers: the same three conditions on vouchers", () => {
    expect(v.sql).toContain('from "vouchers"');
    expect(v.sql).toContain('"vouchers"."source" = $1');
    expect(v.sql).toContain('"vouchers"."created_at" >= $2');
    expect(v.sql).toContain('"vouchers"."created_at" < $3');
    expect(v.params).toEqual(["SALE", W.start.toISOString(), W.end.toISOString()]);
  });
  test("an IMPORT row can never match: the SALE literal is a bound parameter, not 'IMPORT'", () => {
    expect(c.params).not.toContain("IMPORT");
    expect(v.params).not.toContain("IMPORT");
  });
  test("the window is the Bangkok month, so 23:30 on the 31st is inside it and 00:00 on the 1st is outside", () => {
    expect(new Date("2026-10-31T16:30:00Z") < W.end).toBe(true);
    expect(new Date("2026-10-31T17:00:00Z") < W.end).toBe(false);
    expect(new Date("2026-09-30T17:00:00Z") >= W.start).toBe(true);
  });
  test("neither builder was executed (they are not async): they hand back the builder", () => {
    expect(typeof coursesInMonthQuery(d, W).toSQL).toBe("function");
    expect(coursesInMonthQuery(d, W)).not.toBeInstanceOf(Promise);
  });
});

describe("the first-ATTENDED-date queries (rendered SQL, no connection)", () => {
  const fc = firstAttendedByCourseQuery(d, ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]).toSQL();
  const fv = firstAttendedByVoucherQuery(d, ["33333333-3333-4333-8333-333333333333"]).toSQL();
  test("courses: min(date) of ATTENDED sessions, only for the given course ids, grouped by course", () => {
    expect(fc.sql).toContain('select "course_id", min("date") from "bookings"');
    expect(fc.sql).toContain('"bookings"."status" = $1');
    expect(fc.sql).toContain('"bookings"."course_id" in ($2, $3)');
    expect(fc.sql).toContain('group by "bookings"."course_id"');
    expect(fc.params).toEqual(["ATTENDED", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });
  test("vouchers: the same, on voucher_id", () => {
    expect(fv.sql).toContain('select "voucher_id", min("date") from "bookings"');
    expect(fv.sql).toContain('"bookings"."voucher_id" in ($2)');
    expect(fv.sql).toContain('group by "bookings"."voucher_id"');
    expect(fv.params).toEqual(["ATTENDED", "33333333-3333-4333-8333-333333333333"]);
  });
  test("only ATTENDED counts as the first session: a cancelled or pending one never sets the date", () => {
    expect(fc.params).not.toContain("CONFIRMED");
    expect(fc.params).not.toContain("PENDING");
  });
});

describe("listBonusCandidates — composition", () => {
  const row = (over: Partial<PurchaseRow> = {}): PurchaseRow => ({
    kind: "COURSE",
    id: "p",
    createdAt: "2026-10-15T05:00:00Z",
    isDuo: false,
    child: { id: "k", name: "Nong A", nickname: null },
    trial: { bookingId: "t", date: "2026-09-20", subject: "Skateboard", coachId: "c" },
    prev: { kind: "COURSE", id: "o", createdAt: "2026-06-01T05:00:00Z", firstTeacherId: "f", latestTeacherId: null, coachChangedAt: null, bonus100Pick: null, firstAttendedDate: "2026-06-08" },
    ...over,
  });

  test("returns { bonus50, bonus100 } from what the loader gives it, for the month asked", async () => {
    let asked = "";
    const got = await listBonusCandidates("2026-10", DEFAULT_RULES, async (m) => ((asked = m), [row()]));
    expect(asked).toBe("2026-10");
    expect(Object.keys(got).sort()).toEqual(["bonus100", "bonus50"]);
    expect(got.bonus50).toHaveLength(1);
    expect(got.bonus100).toHaveLength(1);
  });
  test("belt and braces: a row outside the month is dropped even if the loader returned it", async () => {
    const got = await listBonusCandidates("2026-11", DEFAULT_RULES, async () => [row()]);
    expect(got).toEqual({ bonus50: [], bonus100: [] });
  });
  test("the rules argument reaches the rules (A10 on turns a course→voucher pair into a Bonus 100)", async () => {
    const mixed = row({ kind: "VOUCHER" }); // voucher bought after a course
    expect((await listBonusCandidates("2026-10", DEFAULT_RULES, async () => [mixed])).bonus100).toEqual([]);
    expect((await listBonusCandidates("2026-10", { ...DEFAULT_RULES, renewalAcrossCourseVoucher: true }, async () => [mixed])).bonus100).toHaveLength(1);
  });
  test("rules default to DEFAULT_RULES", async () => {
    const preGoLive = row({ trial: { bookingId: "t", date: "2020-01-01", subject: null, coachId: "c" } });
    expect((await listBonusCandidates("2026-10", undefined, async () => [preGoLive])).bonus50).toHaveLength(1); // no go-live date ⇒ no cut-off
  });
  test.each(["2026-13", "2026-1", "202610", "", "2026-10-01"])("a bad month %p → 400 VALIDATION before any read", async (bad) => {
    let called = false;
    const err = await listBonusCandidates(bad, DEFAULT_RULES, async () => ((called = true), [])).catch((e) => e);
    expect(err).toBeInstanceOf(ApiException);
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION");
    expect(called).toBe(false);
  });
});

// ───────────────────── the assembly, through a fake keyed by table ─────────────────────
type Q = { table: unknown; select: Record<string, unknown>; groupBy?: unknown };
function fakeDb(respond: (q: Q) => unknown[]) {
  const seen: Q[] = [];
  const make = (select: Record<string, unknown>) => {
    const q: Q = { table: undefined, select };
    seen.push(q);
    const proxy: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (res: any, rej: any) => Promise.resolve().then(() => respond(q)).then(res, rej);
          return (...a: any[]) => {
            if (prop === "from") q.table = a[0];
            if (prop === "groupBy") q.groupBy = a[0];
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return { db: { select: make }, seen };
}

describe("loadPurchaseRowsFrom — plain rows from the scheduling tables", () => {
  const T0 = new Date("2026-10-15T05:00:00Z");
  const answers = (q: Q): unknown[] => {
    if (q.table === sbCourses && "coStudentId" in q.select && "fromTrialBookingId" in q.select) {
      return [
        { id: "c-trial", studentId: "s1", coStudentId: null, createdAt: T0, fromTrialBookingId: "tr1", prevCourseId: null, prevVoucherId: null },
        { id: "c-renew", studentId: "s2", coStudentId: "s3", createdAt: T0, fromTrialBookingId: null, prevCourseId: "old-c", prevVoucherId: null },
        { id: "c-lonely", studentId: null, coStudentId: null, createdAt: T0, fromTrialBookingId: null, prevCourseId: null, prevVoucherId: null },
      ];
    }
    if (q.table === sbVouchers && "fromTrialBookingId" in q.select && "createdAt" in q.select && "prevVoucherId" in q.select && !("coStudentId" in q.select) && !("firstTeacherId" in q.select)) {
      return [{ id: "v-renew", studentId: "s1", createdAt: T0, fromTrialBookingId: null, prevCourseId: null, prevVoucherId: "old-v" }];
    }
    if (q.table === sbStudents) return [{ id: "s1", name: "Nong A", nickname: "Aa" }, { id: "s2", name: "Nong B", nickname: null }, { id: "s3", name: "Nong C", nickname: "Cc" }];
    if (q.table === sbBookings && "teacherId" in q.select) return [{ id: "tr1", date: "2026-09-20", subjectId: "sub1", teacherId: "coach-trial" }];
    if (q.table === sbSubjects) return [{ id: "sub1", name: "Skateboard" }];
    if (q.table === sbCourses && "bonus100Pick" in q.select)
      return [{ id: "old-c", createdAt: new Date("2026-06-01T05:00:00Z"), firstTeacherId: "coach-first", latestTeacherId: "coach-latest", coachChangedAt: new Date("2026-08-01T05:00:00Z"), bonus100Pick: "SHARE" }];
    if (q.table === sbVouchers && "firstTeacherId" in q.select) return [{ id: "old-v", createdAt: new Date("2026-05-01T05:00:00Z"), firstTeacherId: "coach-v" }];
    if (q.table === sbBookings && q.groupBy === sbBookings.courseId) return [{ id: "old-c", first: "2026-06-08" }];
    if (q.table === sbBookings && q.groupBy === sbBookings.voucherId) return [{ id: "old-v", first: "2026-05-09" }];
    return [];
  };

  test("assembles child, trial (with subject name and coach), previous entitlement and its first ATTENDED date", async () => {
    const { db } = fakeDb(answers);
    const rows = await loadPurchaseRowsFrom(db, "2026-10");
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(rows).toHaveLength(4);

    expect(by("c-trial")).toMatchObject({ kind: "COURSE", isDuo: false, child: { id: "s1", name: "Nong A", nickname: "Aa" }, trial: { bookingId: "tr1", date: "2026-09-20", subject: "Skateboard", coachId: "coach-trial" }, prev: null });

    const renew = by("c-renew");
    expect(renew.isDuo).toBe(true); // a co_student_id ⇒ DUO
    expect(renew.prev).toMatchObject({ kind: "COURSE", id: "old-c", firstTeacherId: "coach-first", latestTeacherId: "coach-latest", bonus100Pick: "SHARE", firstAttendedDate: "2026-06-08" });

    const vr = by("v-renew");
    expect(vr).toMatchObject({ kind: "VOUCHER", isDuo: false });
    // a voucher as the OLD entitlement has no change / pick columns: it reads as "no change"
    expect(vr.prev).toMatchObject({ kind: "VOUCHER", id: "old-v", firstTeacherId: "coach-v", latestTeacherId: null, coachChangedAt: null, bonus100Pick: null, firstAttendedDate: "2026-05-09" });
  });
  test("a purchase with no readable child is still LISTED (never dropped silently), with an empty name", async () => {
    const { db } = fakeDb(answers);
    const lonely = (await loadPurchaseRowsFrom(db, "2026-10")).find((r) => r.id === "c-lonely")!;
    expect(lonely.child).toEqual({ id: "", name: "", nickname: null });
  });
  test("the assembled rows feed the rules end to end", async () => {
    const { db } = fakeDb(answers);
    const got = await listBonusCandidates("2026-10", { ...DEFAULT_RULES, renewalAcrossCourseVoucher: true }, (m) => loadPurchaseRowsFrom(db, m));
    expect(got.bonus50.map((c) => [c.purchaseId, c.coachId])).toEqual([["c-trial", "coach-trial"]]);
    const b100 = Object.fromEntries(got.bonus100.map((c) => [c.purchaseId, c]));
    expect(b100["c-renew"]).toMatchObject({ status: "RESOLVED", pick: "SHARE", shares: [{ coachId: "coach-first", fraction: 0.5 }, { coachId: "coach-latest", fraction: 0.5 }], prevFirstAttendedDate: "2026-06-08" });
    // v-renew is a voucher bought after a voucher: NEVER a renewal, even with A10 on (the assembled row says so, the rule refuses it)
    expect(b100["v-renew"]).toBeUndefined();
    expect(Object.keys(b100)).toEqual(["c-renew"]);
  });
  test("no sales in the month ⇒ [] and no further query is made", async () => {
    const { db, seen } = fakeDb(() => []);
    expect(await loadPurchaseRowsFrom(db, "2026-10")).toEqual([]);
    expect(seen).toHaveLength(2); // the two purchase queries only
  });
  test("only queries for ids that exist: no trials ⇒ no booking lookup", async () => {
    const { db, seen } = fakeDb((q) =>
      q.table === sbCourses && "coStudentId" in q.select ? [{ id: "c1", studentId: "s1", coStudentId: null, createdAt: new Date("2026-10-15T05:00:00Z"), fromTrialBookingId: null, prevCourseId: null, prevVoucherId: null }] : q.table === sbStudents ? [{ id: "s1", name: "A", nickname: null }] : [],
    );
    await loadPurchaseRowsFrom(db, "2026-10");
    expect(seen.some((q) => q.table === sbBookings)).toBe(false);
  });
});

describe("read-only by construction", () => {
  const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
  const WRITES = /insert\(|update\(|delete\(|execute\(|\.transaction\b/;
  test("the service and the rules never write", async () => {
    expect(await read("./bonus-candidates.service.ts")).not.toMatch(WRITES);
    expect(await read("../lib/bonus-rules.ts")).not.toMatch(WRITES);
  });
  test("every `d.` call in the service is a select", async () => {
    const verbs = [...(await read("./bonus-candidates.service.ts")).matchAll(/\bd\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]);
    expect(verbs.length).toBeGreaterThan(0);
    expect(verbs.every((v) => v === "select")).toBe(true);
  });
  test("the read-only table file declares no enum, FK or bo table, and drizzle.config.ts never names it", async () => {
    const src = await read("../db/schema-salary-b-read.ts");
    expect(src).not.toMatch(/pgEnum|pgSchema|\.references\(|bo\.table|insert\(|update\(|delete\(/);
    expect(await read("../../drizzle.config.ts")).not.toContain("schema-salary-b-read");
  });
  test("there is no route: api.ts does not mention the reader", async () => {
    expect(await read("../routes/api.ts")).not.toMatch(/bonus-candidates/);
  });
});
