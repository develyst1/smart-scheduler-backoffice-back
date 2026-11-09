// TASK-863 (REQ-120 R1.2, DECISIONS row 12) — Bonus 50 / Bonus 100 CANDIDATES for a month, from the scheduling DB.
// READ-ONLY: it only ever SELECTs, writes nothing, pays nothing, and has no route (`api.ts` is shared and waits its
// turn; the function is the contract, the pay-line TASK calls it).
//
// Two halves, like `hours-reader.ts`:
//   • `loadPurchaseRows(db, month)` — the only DB read: the courses and vouchers SOLD in that Bangkok month
//     (`source = 'SALE'`), each joined, in plain rows, to its child, its 1st Trial, its previous entitlement and that
//     entitlement's first ATTENDED date. A few simple SELECTs, assembled in memory.
//   • `src/lib/bonus-rules.ts` — PURE: every rule, every switch.
//
// 🔑 The query builders are exported on their own so a test can render their SQL (`.toSQL()`, no connection) and prove the
// month window and `source = 'SALE'` without a database.
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { sbBookings, sbCourses, sbStudents, sbSubjects, sbTeachers, sbVouchers } from "../db/schema-salary-b-read";
import { badRequest } from "../lib/http";
import {
  bonus100Candidates,
  bonus50Candidates,
  DEFAULT_RULES,
  windowBounds,
  type BonusWindow,
  type Bonus100Candidate,
  type Bonus50Candidate,
  type BonusRules,
  type PrevRef,
  type PurchaseRow,
  type TrialRef,
} from "../lib/bonus-rules";

export interface BonusCandidates {
  bonus50: Bonus50Candidate[];
  bonus100: Bonus100Candidate[];
}

/**
 * The candidates for a Bangkok month (`YYYY-MM`). `rules` default to `DEFAULT_RULES`; `load` is injectable only so the
 * composition (month check · rules passthrough · the month filter) is testable without a database.
 */
export async function listBonusCandidates(
  month: BonusWindow,
  rules: BonusRules = DEFAULT_RULES,
  load: (month: BonusWindow) => Promise<PurchaseRow[]> = loadPurchaseRows,
): Promise<BonusCandidates> {
  // 🔻 TASK-867 rework: `month` is a Bangkok month `YYYY-MM` (old callers) OR an inclusive date range `{ from, to }` (the pay period).
  try {
    windowBounds(month);
  } catch {
    throw badRequest(typeof month === "string" ? "month must be YYYY-MM" : "range must be { from, to } as YYYY-MM-DD, from <= to");
  }
  const rows = await load(month);
  return { bonus50: bonus50Candidates(rows, rules, month), bonus100: bonus100Candidates(rows, rules, month) };
}

// ───────────────────────────────── the queries (builders only; nothing runs here) ─────────────────────────────────
// `d` is a drizzle db (or a transaction). Typed loosely, like the rest of this repo's services.

// ⚠️ These two are deliberately NOT `async`: a drizzle query is thenable, and an `async` function that returns one would
// unwrap it and RUN it. They return the unexecuted builder, so a test can call `.toSQL()` on it with no connection.

/** Courses SOLD (not imported) with `created_at` in `[start, end)`. */
export function coursesInMonthQuery(d: any, window: { start: Date; end: Date }) {
  return d
    .select({
      id: sbCourses.id,
      studentId: sbCourses.studentId,
      coStudentId: sbCourses.coStudentId,
      createdAt: sbCourses.createdAt,
      fromTrialBookingId: sbCourses.fromTrialBookingId,
      prevCourseId: sbCourses.prevCourseId,
      prevVoucherId: sbCourses.prevVoucherId,
    })
    .from(sbCourses)
    .where(and(eq(sbCourses.source, "SALE"), gte(sbCourses.createdAt, window.start), lt(sbCourses.createdAt, window.end)));
}

/** Vouchers SOLD (not imported) with `created_at` in `[start, end)`. */
export function vouchersInMonthQuery(d: any, window: { start: Date; end: Date }) {
  return d
    .select({
      id: sbVouchers.id,
      studentId: sbVouchers.studentId,
      createdAt: sbVouchers.createdAt,
      fromTrialBookingId: sbVouchers.fromTrialBookingId,
      prevCourseId: sbVouchers.prevCourseId,
      prevVoucherId: sbVouchers.prevVoucherId,
    })
    .from(sbVouchers)
    .where(and(eq(sbVouchers.source, "SALE"), gte(sbVouchers.createdAt, window.start), lt(sbVouchers.createdAt, window.end)));
}

/** The first ATTENDED session date of each given course: `min(date)` of its ATTENDED sessions. */
export function firstAttendedByCourseQuery(d: any, courseIds: readonly string[]) {
  return d
    .select({ id: sbBookings.courseId, first: sql<string>`min(${sbBookings.date})` })
    .from(sbBookings)
    .where(and(eq(sbBookings.status, "ATTENDED"), inArray(sbBookings.courseId, [...courseIds])))
    .groupBy(sbBookings.courseId);
}

/** The same for vouchers. */
export function firstAttendedByVoucherQuery(d: any, voucherIds: readonly string[]) {
  return d
    .select({ id: sbBookings.voucherId, first: sql<string>`min(${sbBookings.date})` })
    .from(sbBookings)
    .where(and(eq(sbBookings.status, "ATTENDED"), inArray(sbBookings.voucherId, [...voucherIds])))
    .groupBy(sbBookings.voucherId);
}

/** Which of these coaches are the system teacher ("No Teacher", `is_system`). Never a bonus coach (TASK-861's relayed rule). */
export function systemTeachersQuery(d: any, coachIds: readonly string[]) {
  return d.select({ id: sbTeachers.id }).from(sbTeachers).where(and(eq(sbTeachers.isSystem, true), inArray(sbTeachers.id, [...coachIds])));
}

const uniq = (xs: readonly (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))];

// ───────────────────────────────── the one DB read ─────────────────────────────────

/** Reads a month's sales and assembles plain rows for the pure rules. Read-only: SELECTs only. */
export async function loadPurchaseRows(month: BonusWindow): Promise<PurchaseRow[]> {
  const { db } = await import("../db");
  return loadPurchaseRowsFrom(db, month);
}

/** `loadPurchaseRows` on a given db (so a read-only check can pass its own). */
export async function loadPurchaseRowsFrom(d: any, month: BonusWindow): Promise<PurchaseRow[]> {
  const window = windowBounds(month);

  const [courses, vouchers] = await Promise.all([coursesInMonthQuery(d, window), vouchersInMonthQuery(d, window)]);
  const sold: { kind: "COURSE" | "VOUCHER"; row: any }[] = [
    ...courses.map((row: any) => ({ kind: "COURSE" as const, row })),
    ...vouchers.map((row: any) => ({ kind: "VOUCHER" as const, row })),
  ];
  if (!sold.length) return [];

  const trialIds = uniq(sold.map((s) => s.row.fromTrialBookingId));
  const prevCourseIds = uniq(sold.map((s) => s.row.prevCourseId));
  const prevVoucherIds = uniq(sold.map((s) => s.row.prevVoucherId));
  const studentIds = uniq(sold.flatMap((s) => [s.row.studentId, s.row.coStudentId]));

  const [students, trials, prevCourses, prevVouchers, courseFirst, voucherFirst] = await Promise.all([
    studentIds.length ? d.select({ id: sbStudents.id, name: sbStudents.name, nickname: sbStudents.nickname }).from(sbStudents).where(inArray(sbStudents.id, studentIds)) : [],
    trialIds.length ? d.select({ id: sbBookings.id, date: sbBookings.date, subjectId: sbBookings.subjectId, teacherId: sbBookings.teacherId }).from(sbBookings).where(inArray(sbBookings.id, trialIds)) : [],
    prevCourseIds.length
      ? d
          .select({ id: sbCourses.id, createdAt: sbCourses.createdAt, firstTeacherId: sbCourses.firstTeacherId, latestTeacherId: sbCourses.latestTeacherId, coachChangedAt: sbCourses.coachChangedAt, bonus100Pick: sbCourses.bonus100Pick })
          .from(sbCourses)
          .where(inArray(sbCourses.id, prevCourseIds))
      : [],
    prevVoucherIds.length ? d.select({ id: sbVouchers.id, createdAt: sbVouchers.createdAt, firstTeacherId: sbVouchers.firstTeacherId }).from(sbVouchers).where(inArray(sbVouchers.id, prevVoucherIds)) : [],
    // the previous entitlement's first ATTENDED date: min(date) of its ATTENDED sessions
    prevCourseIds.length ? firstAttendedByCourseQuery(d, prevCourseIds) : [],
    prevVoucherIds.length ? firstAttendedByVoucherQuery(d, prevVoucherIds) : [],
  ]);

  const subjectIds = uniq(trials.map((t: any) => t.subjectId));
  const subjects: { id: string; name: string }[] = subjectIds.length ? await d.select({ id: sbSubjects.id, name: sbSubjects.name }).from(sbSubjects).where(inArray(sbSubjects.id, subjectIds)) : [];

  // every coach the rules could name: the trial's, and the old entitlements' first / latest. Which are the system teacher?
  const coachIds = uniq([
    ...trials.map((t: any) => t.teacherId),
    ...prevCourses.flatMap((c: any) => [c.firstTeacherId, c.latestTeacherId]),
    ...prevVouchers.map((v: any) => v.firstTeacherId),
  ]);
  const systemIds = new Set<string>(coachIds.length ? (await systemTeachersQuery(d, coachIds)).map((r: any) => r.id) : []);
  const isSystem = (id: string | null | undefined): boolean => !!id && systemIds.has(id);

  const studentBy = new Map<string, any>(students.map((s: any) => [s.id, s]));
  const subjectBy = new Map<string, string>(subjects.map((s) => [s.id, s.name]));
  const trialBy = new Map<string, TrialRef>(
    trials.map((t: any) => [t.id, { bookingId: t.id, date: t.date, subject: t.subjectId ? (subjectBy.get(t.subjectId) ?? null) : null, coachId: t.teacherId, coachIsSystem: isSystem(t.teacherId) }]),
  );
  const courseFirstBy = new Map<string, string>(courseFirst.map((r: any) => [r.id, r.first]));
  const voucherFirstBy = new Map<string, string>(voucherFirst.map((r: any) => [r.id, r.first]));
  const prevCourseBy = new Map<string, PrevRef>(
    prevCourses.map((c: any) => [
      c.id,
      { kind: "COURSE", id: c.id, createdAt: c.createdAt, firstTeacherId: c.firstTeacherId, latestTeacherId: c.latestTeacherId, coachChangedAt: c.coachChangedAt, bonus100Pick: c.bonus100Pick, firstAttendedDate: courseFirstBy.get(c.id) ?? null, firstTeacherIsSystem: isSystem(c.firstTeacherId), latestTeacherIsSystem: isSystem(c.latestTeacherId) },
    ]),
  );
  const prevVoucherBy = new Map<string, PrevRef>(
    prevVouchers.map((v: any) => [
      v.id,
      // a voucher has no coach-change / pick columns: it always reads as "no change"
      { kind: "VOUCHER", id: v.id, createdAt: v.createdAt, firstTeacherId: v.firstTeacherId, latestTeacherId: null, coachChangedAt: null, bonus100Pick: null, firstAttendedDate: voucherFirstBy.get(v.id) ?? null, firstTeacherIsSystem: isSystem(v.firstTeacherId), latestTeacherIsSystem: false },
    ]),
  );

  return sold.map(({ kind, row }): PurchaseRow => {
    const st = row.studentId ? studentBy.get(row.studentId) : undefined;
    return {
      kind,
      id: row.id,
      createdAt: row.createdAt,
      isDuo: kind === "COURSE" && !!row.coStudentId,
      // A purchase with no readable child is still LISTED (never dropped silently); its name is empty.
      child: { id: row.studentId ?? "", name: st?.name ?? "", nickname: st?.nickname ?? null },
      trial: row.fromTrialBookingId ? (trialBy.get(row.fromTrialBookingId) ?? null) : null,
      prev: row.prevCourseId ? (prevCourseBy.get(row.prevCourseId) ?? null) : row.prevVoucherId ? (prevVoucherBy.get(row.prevVoucherId) ?? null) : null,
    };
  });
}
