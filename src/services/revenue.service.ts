// Revenue by activity + per-customer spend (SPEC-021 / TASK-064).
//
// The queries live here; every rule lives in `lib/revenue-attribution.ts` and is unit-tested without a DB.
//
// ⚠️ ONE attribution map serves BOTH endpoints — `loadAttributedSales` is the only place that decides what a
// sale points at. Building it twice is how two screens end up disagreeing about one month's total.

import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import {
  boItem,
  boMovement,
  pubBookings,
  pubCoursePackages,
  pubStudents,
  pubSubjects,
  pubVouchers,
} from "../db/schema";
import {
  attributeSales,
  bangkokMonthRangeUtc,
  groupByStudent,
  groupBySubject,
  inMonthBangkok,
  type AttributedSale,
  type CustomerSpend,
  type RevenueByActivity,
} from "../lib/revenue-attribution";

/**
 * Every SALE movement in `month`, resolved against `public`.
 *
 * The month filter is applied **in Bangkok time, in JS** rather than in SQL — see `inMonthBangkok`. This is
 * money bucketed by month, so TASK-062's UTC bug would literally move revenue between months here.
 */
async function loadAttributedSales(month: string): Promise<AttributedSale[]> {
  const window = bangkokMonthRangeUtc(month);
  const rows = await db
    .select({
      refId: boMovement.refId,
      productCode: boItem.externalRef,
      valueMinor: boMovement.valueMinor,
      createdAt: boMovement.createdAt,
    })
    .from(boMovement)
    .innerJoin(boItem, eq(boItem.id, boMovement.itemId))
    .where(
      and(
        eq(boMovement.refType, "SALE"),
        gte(boMovement.createdAt, window.start),
        lt(boMovement.createdAt, window.end),
      ),
    );

  const sales = rows.filter((r) => inMonthBangkok(r.createdAt, month));
  const refIds = sales.map((s) => s.refId).filter((r): r is string => r !== null);
  if (refIds.length === 0) return attributeSales(sales, emptySources());

  // Load only the rows these sales actually reference. A sale whose refId no longer resolves simply won't
  // be found and lands in `unattributed` — never dropped, never thrown.
  const [courses, vouchers, bookings] = await Promise.all([
    db.select().from(pubCoursePackages).where(inArray(pubCoursePackages.id, refIds)),
    db.select().from(pubVouchers).where(inArray(pubVouchers.id, refIds)),
    db.select().from(pubBookings).where(inArray(pubBookings.id, refIds)),
  ]);

  // A course's sport comes from its own bookings (a course ⇔ one subject, REQ-010).
  const courseIds = courses.map((c) => c.id);
  const courseBookings = courseIds.length
    ? await db.select().from(pubBookings).where(inArray(pubBookings.courseId, courseIds))
    : [];
  const subjectByCourse = new Map<string, string>();
  for (const b of courseBookings) {
    if (b.courseId && !subjectByCourse.has(b.courseId)) subjectByCourse.set(b.courseId, b.subjectId);
  }

  return attributeSales(sales, {
    courses: new Map(
      courses.map((c) => [c.id, { studentId: c.studentId, subjectId: subjectByCourse.get(c.id) ?? null }]),
    ),
    vouchers: new Map(vouchers.map((v) => [v.id, { studentId: v.studentId }])),
    bookings: new Map(bookings.map((b) => [b.id, { studentId: b.studentId, subjectId: b.subjectId }])),
  });
}

const emptySources = () => ({ courses: new Map(), vouchers: new Map(), bookings: new Map() });

/** Names for whichever ids the attributed sales actually mention — no full-table reads. */
async function namesFor(ids: { subjects: string[]; students: string[] }) {
  const [subjects, students] = await Promise.all([
    ids.subjects.length
      ? db.select().from(pubSubjects).where(inArray(pubSubjects.id, ids.subjects))
      : Promise.resolve([]),
    ids.students.length
      ? db.select().from(pubStudents).where(inArray(pubStudents.id, ids.students))
      : Promise.resolve([]),
  ]);
  return {
    subject: new Map(subjects.map((s) => [s.id, s.name])),
    student: new Map(students.map((s) => [s.id, s.nickname || s.name])),
  };
}

export async function getRevenueByActivity(month: string): Promise<RevenueByActivity> {
  const attributed = await loadAttributedSales(month);
  const { subject } = await namesFor({
    subjects: [...new Set(attributed.map((a) => a.subjectId).filter((s): s is string => !!s))],
    students: [],
  });
  return groupBySubject(attributed, month, (id) => subject.get(id) ?? id);
}

export async function getCustomerSpend(month: string, q?: string): Promise<{
  month: string;
  customers: CustomerSpend[];
}> {
  const attributed = await loadAttributedSales(month);
  const { student } = await namesFor({
    subjects: [],
    students: [...new Set(attributed.map((a) => a.studentId).filter((s): s is string => !!s))],
  });
  return { month, customers: groupByStudent(attributed, (id) => student.get(id) ?? id, q) };
}
