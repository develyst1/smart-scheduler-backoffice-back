import { and, asc, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { rpBookings, rpParents, rpStudents, rpSubjects } from "../db/schema";
import { bangkokDate, escapeLike } from "../lib/revenue-ledger";
import { liveEntitlementsByStudent, type LiveEntitlements } from "../lib/reports-live";

/**
 * 🔻 TASK-924 / SPEC-103 §3 — the STUDENT register ("ทะเบียนนักเรียน"). Read-only; NO money on this page, so there is no
 * role switch here. Personal data (children's names, a parent's phone, birth dates): staff-only behind the route's gate;
 * nothing is logged per row.
 *
 * Queries per call: FOUR, fixed — (1) students ⨝ parents, (2) live entitlements (reports-live, grouped),
 * (3) one grouped bookings aggregate, (4) subject names. Never one per student.
 */

export type StudentStatus = "ACTIVE" | "INACTIVE";
export interface StudentsQuery {
  q?: string;
  status: StudentStatus | "ALL";
  subjectId?: string;
}
export interface StudentRow {
  studentId: string;
  name: string;
  nickname: string | null;
  gender: string | null;
  birthDate: string | null;
  age: number | null;
  parentName: string | null;
  parentPhone: string | null;
  province: string | null;
  activities: string[];
  status: StudentStatus;
  liveEntitlements: number;
  firstSeenOn: string;
  lastAttendedOn: string | null;
}
export interface StudentsReport {
  rows: StudentRow[];
  counts: { active: number; inactive: number };
}

export interface StudentRecord {
  id: string;
  name: string;
  nickname: string | null;
  gender: string | null;
  birthDate: string | null;
  createdAt: Date | string;
  parentName: string | null;
  parentPhone: string | null;
  province: string | null;
}
export interface BookingAgg {
  studentId: string;
  subjectIds: string[];
  lastAttendedOn: string | null;
}
/** The four reads, as a seam so the shape is testable without a database. */
export interface StudentsStore {
  /** Non-archived students; `pattern` (already LIKE-escaped, `%…%`) matches name / nickname / parent phone. Ordered by name. */
  listStudents(pattern: string | null): Promise<StudentRecord[]>;
  live(asOf: string): Promise<Map<string, LiveEntitlements>>;
  bookings(): Promise<BookingAgg[]>;
  subjects(): Promise<{ id: string; name: string }[]>;
}

/** Whole years on `today` (a Bangkok YYYY-MM-DD). Null for a missing/garbled date or one in the future. */
export function ageOn(birthDate: string | null, today: string): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  if (age < 0) return null;
  return age;
}

export const dbStudentsStore: StudentsStore = {
  async listStudents(pattern) {
    const match = pattern ? or(ilike(rpStudents.name, pattern), ilike(rpStudents.nickname, pattern), ilike(rpParents.phone, pattern)) : undefined;
    const rows = await db
      .select({
        id: rpStudents.id,
        name: rpStudents.name,
        nickname: rpStudents.nickname,
        gender: rpStudents.gender,
        birthDate: rpStudents.birthDate,
        createdAt: rpStudents.createdAt,
        parentName: rpParents.name,
        parentPhone: rpParents.phone,
        province: rpParents.province,
      })
      .from(rpStudents)
      .leftJoin(rpParents, sql`${rpParents.id} = ${rpStudents.parentId}`)
      .where(and(isNull(rpStudents.archivedAt), match))
      .orderBy(asc(rpStudents.name), asc(rpStudents.id));
    return rows;
  },
  live: (asOf) => liveEntitlementsByStudent(asOf),
  async bookings() {
    const rows = (await db.execute(sql`
      select student_id::text as student_id,
             array_agg(distinct subject_id::text) as subject_ids,
             max(date) filter (where status = 'ATTENDED')::text as last_attended_on
        from public.bookings group by student_id
    `)) as unknown as { student_id: string; subject_ids: string[]; last_attended_on: string | null }[];
    return rows.map((r) => ({ studentId: r.student_id, subjectIds: r.subject_ids, lastAttendedOn: r.last_attended_on }));
  },
  async subjects() {
    return db.select({ id: rpSubjects.id, name: rpSubjects.name }).from(rpSubjects);
  },
};

export async function reportStudents(
  q: StudentsQuery,
  deps: { store?: StudentsStore; now?: Date } = {},
): Promise<StudentsReport> {
  const store = deps.store ?? dbStudentsStore;
  const today = bangkokDate(deps.now ?? new Date());
  const term = q.q?.trim();
  const pattern = term ? `%${escapeLike(term)}%` : null;

  const [students, live, bookings, subjects] = await Promise.all([
    store.listStudents(pattern),
    store.live(today),
    store.bookings(),
    store.subjects(),
  ]);
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  const agg = new Map(bookings.map((b) => [b.studentId, b]));
  const names = (ids: string[]): string[] =>
    [...new Set(ids.map((id) => subjectName.get(id)).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b));

  const all: { row: StudentRow; subjectIds: string[] }[] = students.map((s) => {
    const l = live.get(s.id);
    const b = agg.get(s.id);
    const liveCount = l?.count ?? 0;
    // activities: the subjects of the live entitlements; when none is live, every subject the student ever booked.
    const subjectIds = liveCount > 0 ? l!.subjectIds : (b?.subjectIds ?? []);
    return {
      subjectIds,
      row: {
        studentId: s.id,
        name: s.name,
        nickname: s.nickname,
        gender: s.gender,
        birthDate: s.birthDate,
        age: ageOn(s.birthDate, today),
        parentName: s.parentName,
        parentPhone: s.parentPhone,
        province: s.province,
        activities: names(subjectIds),
        status: liveCount > 0 ? "ACTIVE" : "INACTIVE",
        liveEntitlements: liveCount,
        firstSeenOn: bangkokDate(s.createdAt),
        lastAttendedOn: b?.lastAttendedOn ?? null,
      },
    };
  });

  // counts follow the search and the activity filter, NOT the status tab — so the tabs show both numbers.
  const scoped = q.subjectId ? all.filter((x) => x.subjectIds.includes(q.subjectId!)) : all;
  const counts = {
    active: scoped.filter((x) => x.row.status === "ACTIVE").length,
    inactive: scoped.filter((x) => x.row.status === "INACTIVE").length,
  };
  const rows = scoped.filter((x) => q.status === "ALL" || x.row.status === q.status).map((x) => x.row);
  return { rows, counts };
}
