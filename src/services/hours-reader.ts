// SPEC-101 §5 (link 2) / TASK-872 — the hours reader: the scheduling timetable → TEACHING MINUTES per calendar day per
// class type, for one coach. READ-ONLY by construction: it only ever SELECTs, and it computes no pay (links 1 and 3 own
// rates and roles). The correctness of a coach's slip rests on this file, so the rules are written down here and
// pinned by fixtures of real timetable shapes (`hours-reader.fixtures.ts`).
//
// Two halves, on purpose:
//   • `collectRows`  — the ONLY database read: the `bookings` rows a coach is on in the period, plus the seats of any
//                      GROUP among them (at most two SELECTs).
//   • `bucketMinutes` — PURE. Every rule below lives here and is tested without a database.
//
// ── Where the rules come from (TASK-872 Implementation Notes, Step 0 — smart-scheduler-back, with file:line) ──────
//   A class a coach taught is one `bookings` row. A GROUP's children are SEAT rows (`group_id` set) that hold no slot;
//   the GROUP row is the one booking the coach teaches. Extra coaches are in `booking_teachers`.
//
// 🔑 Every rule is a NAMED constant or a branch of `classifyRow`, and every one is a decision that moves money. The
// ones marked [Q#] are the defaults offered to the SA in TASK-872 ## Questions; a different answer is a one-line change.
import { badRequest } from "../lib/http";

/** The five class types of the contract (SPEC-101 §5 / R1.x). A local string union: it does not import TASK-871's enum. */
export const CLASS_TYPES = ["private", "duo", "group", "eca", "camp"] as const;
export type ClassType = (typeof CLASS_TYPES)[number];

/** One day of teaching. Every number is an INTEGER NUMBER OF MINUTES — never hours (SPEC-101 §5, resolved 2026-11-08). */
export interface HoursDay {
  /** Asia/Bangkok calendar date, `YYYY-MM-DD`. */
  date: string;
  byType: Record<ClassType, number>;
  teachingMinutesTotal: number;
  /**
   * TASK-884 / SPEC-101 §5 R1.6 — WHO was taught that day, per class type: one entry per class type that has teaching that day
   * (`byType[t] > 0`), in `CLASS_TYPES` order. LABELS ONLY: link 3 prints them, they never move money. `names` is one entry per
   * child (nickname, else name; never joined), de-duplicated, ordered by the child's first lesson start that day, then by name. It is
   * EMPTY for a type whose rows carry no child (a title-only ECA, the derived CAMP rows): never invented.
   */
  students: Array<{ classType: ClassType; names: string[] }>;
}

/** A child as the names need it (SB `students`: `id`, `name`, `nickname`). */
export interface ChildRef {
  id: string;
  name: string;
  nickname: string | null;
}

/** What `collectRows` returns: just the columns the rules read. */
export interface TimetableRow {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  bookingType: string;
  status: string;
  groupId: string | null;
  otherKind: string | null;
  coStudentId: string | null;
  slotYieldedAt: Date | string | null;
  /** TASK-884 — the row's child and a DUO row's second child, joined from `students`; absent/null ⇒ none. Names only; no rule reads them. */
  student?: ChildRef | null;
  coStudent?: ChildRef | null;
}

// ───────────────────────────────── the rules ─────────────────────────────────

/**
 * [Q1] The statuses that mean "a class the coach was there for". CONFIRMED + ATTENDED + NO_SHOW.
 *  - ATTENDED: taught. The day-end job marks every unmarked CONFIRMED class ATTENDED once its start has passed
 *    (`jobs.service.ts:56-83`, no booking-type filter), so a child who did not come, with the coach present, is
 *    ATTENDED in the data (REQ-120 §9.4 #3: the hour counts for the coach).
 *  - NO_SHOW: legacy rows from before that job rule; the same §9.4 #3 case, kept so old months still add up.
 *  - CONFIRMED: confirmed and on the timetable (a class not yet cut by the day-end, or in the future).
 *  Not counted: PENDING and EXTENDED (never confirmed; the day-end never settles them), SICK_LEAVE, PENDING_RESCHEDULE,
 *  PAUSED, CANCELLED (the timetable's own non-holding statuses, `schema.ts` SLOT_INACTIVE_STATUSES).
 */
export const COUNTED_STATUSES: ReadonlySet<string> = new Set(["CONFIRMED", "ATTENDED", "NO_SHOW"]);

/**
 * [Q3, FLIPPED 2026-11-08 by the SA on Khwan's answer] A GROUP row with no live child is NOT the coach's work.
 * REQ-105 §5 #4 (Khwan, 2026-09-23, via Porter): "Empty week ⇒ the coach is FREE (can be booked for other work). A group
 * slot with students blocks the coach." So a GROUP row counts only while it has at least one LIVE seat; set this to
 * `true` to count every GROUP row again (the earlier default).
 *
 * A seat is LIVE when its status is one this reader counts (CONFIRMED / ATTENDED / NO_SHOW): a seat on sick leave,
 * cancelled, paused or still PENDING is not a child the coach is teaching that day.
 */
export const COUNT_EMPTY_GROUP = false;

/** Lesson types: a Private unless a second child makes it a DUO. VOUCHER and the trial are Privates [Q6]. */
const LESSON_TYPES: ReadonlySet<string> = new Set(["FIRST_TRIAL", "SINGLE_SESSION", "COURSE_PACKAGE", "VOUCHER"]);

export type SkipReason =
  | "status" //                 not a counted status
  | "seat" //                   a GROUP's child: the GROUP row is what the coach teaches
  | "yielded" //                [Q4] a GROUP row that gave its coach-hour to a Private
  | "empty-group" //            [Q3] a GROUP row with no live seat (REQ-105 §5 #4: the coach is free)
  | "not-a-class-type" //       [Q2] OTHER with no kind (meeting · maintenance · visit), FREE, KOL
  | "unknown-group-kind" //     a GROUP row that is neither DUO nor GROUP: surfaced, never guessed into a bucket
  | "unknown-booking-type" //   a type this reader does not know
  | "no-duration"; //           end is not after start (bad data): nothing to count

export type Classified = { type: ClassType; minutes: number } | { skipped: SkipReason };

/** `HH:MM[:SS]` → seconds since midnight. Anything unparseable is NaN, which `minutesBetween` turns into 0. */
const secondsOf = (t: string): number => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t ?? "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : NaN;
};

/** Whole minutes from `start` to `end`, rounded; 0 when the end is not after the start. A class does not cross midnight. */
export function minutesBetween(start: string, end: string): number {
  const s = secondsOf(start);
  const e = secondsOf(end);
  const diff = e - s;
  return Number.isFinite(diff) && diff > 0 ? Math.round(diff / 60) : 0;
}

/** The ids of the GROUP rows that have at least one LIVE seat among `rows` (a seat is live when its status is counted). Pure. */
export function liveGroupIds(rows: readonly TimetableRow[]): Set<string> {
  const live = new Set<string>();
  for (const r of rows) if (r.groupId && COUNTED_STATUSES.has(r.status)) live.add(r.groupId);
  return live;
}

const NO_GROUPS: ReadonlySet<string> = new Set();

/**
 * Which class type a row is, and its minutes, or WHY it is not counted. Pure.
 *
 *  - A SEAT (`group_id` set) is never counted. Its GROUP row is counted ONCE, by its own minutes, however many
 *    children are seated, and only while it has a live child [Q3 flipped: `liveGroups` is `liveGroupIds(rows)`].
 *  - GROUP row kind DUO → `duo`; GROUP → `group`. A DUO COURSE in its own slot (a second child, no group) → `duo`.
 *  - OTHER kind ECA → `eca`; CAMP → `camp`. OTHER with no kind, FREE, KOL → not a class type [Q2].
 */
export function classifyRow(r: TimetableRow, liveGroups: ReadonlySet<string> = NO_GROUPS): Classified {
  if (r.groupId) return { skipped: "seat" };
  if (!COUNTED_STATUSES.has(r.status)) return { skipped: "status" };

  let type: ClassType | null;
  if (r.bookingType === "GROUP") {
    if (r.slotYieldedAt) return { skipped: "yielded" };
    if (r.otherKind === "DUO") type = "duo";
    else if (r.otherKind === "GROUP") type = "group";
    else return { skipped: "unknown-group-kind" }; // before the emptiness check: a rule gap is surfaced, not hidden as "empty"
    if (!COUNT_EMPTY_GROUP && !liveGroups.has(r.id)) return { skipped: "empty-group" };
  } else if (r.bookingType === "OTHER") {
    if (r.otherKind === "ECA") type = "eca";
    else if (r.otherKind === "CAMP") type = "camp";
    else return { skipped: "not-a-class-type" };
  } else if (LESSON_TYPES.has(r.bookingType)) {
    type = r.coStudentId ? "duo" : "private";
  } else {
    return { skipped: "unknown-booking-type" };
  }

  const minutes = minutesBetween(r.startTime, r.endTime);
  return minutes > 0 ? { type, minutes } : { skipped: "no-duration" };
}

const zeroByType = (): Record<ClassType, number> => ({ private: 0, duo: 0, group: 0, eca: 0, camp: 0 });

/**
 * The pure core: rows → one entry per calendar day that has teaching, ascending by date. Days with none are omitted.
 * Every row handed in is one the coach is on (as first or extra coach), so each is counted with its FULL minutes:
 * two coaches on one ECA each get the whole row [declared default; the capacity number does the same].
 */
export function bucketMinutes(rows: readonly TimetableRow[]): HoursDay[] {
  const byDate = new Map<string, Record<ClassType, number>>();
  const kids = new Map<string, Map<ClassType, Map<string, KidSeen>>>(); // date → class type → child id → first start + label
  const live = liveGroupIds(rows);
  const seatsOf = liveSeatsByGroup(rows);
  for (const r of rows) {
    const c = classifyRow(r, live);
    if ("skipped" in c) continue; // a row that adds no minutes adds no name either
    const day = byDate.get(r.date) ?? zeroByType();
    day[c.type] += c.minutes;
    byDate.set(r.date, day);

    const types = kids.get(r.date) ?? new Map<ClassType, Map<string, KidSeen>>();
    const seen = types.get(c.type) ?? new Map<string, KidSeen>();
    const start = secondsOf(r.startTime);
    for (const child of childrenTaught(r, seatsOf)) {
      const prior = seen.get(child.id);
      if (!prior || start < prior.start) seen.set(child.id, { start, label: nameOf(child) });
    }
    types.set(c.type, seen);
    kids.set(r.date, types);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, byType]) => ({
      date,
      byType,
      teachingMinutesTotal: CLASS_TYPES.reduce((n, t) => n + byType[t], 0),
      students: CLASS_TYPES.filter((t) => byType[t] > 0).map((classType) => ({
        classType,
        names: [...(kids.get(date)?.get(classType)?.values() ?? [])]
          .sort((a, b) => (a.start === b.start ? compareText(a.label, b.label) : a.start < b.start ? -1 : 1))
          .map((k) => k.label),
      })),
    }));
}

// ───────────────────────────────── the names (TASK-884 / R1.6) ─────────────────────────────────

interface KidSeen {
  start: number;
  label: string;
}

/** One child's label, the way SB prints it (`studentNamesOf`, mappers.ts:194): the nickname, else the name. */
export function nameOf(c: ChildRef): string {
  return c.nickname?.trim() ? c.nickname.trim() : c.name.trim();
}

/** Code-point order, not locale order: the same input always gives the same output on every machine. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** group id → the LIVE seat rows of that group (a seat is live when its status is counted: the same rule as `liveGroupIds`). */
function liveSeatsByGroup(rows: readonly TimetableRow[]): Map<string, TimetableRow[]> {
  const out = new Map<string, TimetableRow[]>();
  for (const r of rows) {
    if (!r.groupId || !COUNTED_STATUSES.has(r.status)) continue;
    out.set(r.groupId, [...(out.get(r.groupId) ?? []), r]);
  }
  return out;
}

/**
 * The children a COUNTED row stands for. A GROUP row stands for the children of its LIVE seats — never its own `student_id` (the
 * group's first child is also a seat, or not, but the GROUP row itself names nobody), never a dead seat. Every other counted
 * row stands for its own child plus a DUO row's second child. A row that carries none (a title-only ECA, a derived CAMP row) stands
 * for nobody: nothing is invented.
 */
export function childrenTaught(r: TimetableRow, seatsOf: ReadonlyMap<string, readonly TimetableRow[]>): ChildRef[] {
  const own = (x: TimetableRow): ChildRef[] => [x.student, x.coStudent].filter((c): c is ChildRef => !!c);
  return r.bookingType === "GROUP" ? (seatsOf.get(r.id) ?? []).flatMap(own) : own(r);
}

/**
 * Nothing is dropped unexplained: for a set of rows, the minutes that were NOT counted, by reason. Pure. Used by the
 * tests and by the sid check to show what the rules excluded; a non-zero `unknown-*` here is a rule gap to report.
 */
export function skippedMinutes(rows: readonly TimetableRow[]): Partial<Record<SkipReason, number>> {
  const out: Partial<Record<SkipReason, number>> = {};
  const live = liveGroupIds(rows);
  for (const r of rows) {
    const c = classifyRow(r, live);
    if (!("skipped" in c)) continue;
    out[c.skipped] = (out[c.skipped] ?? 0) + minutesBetween(r.startTime, r.endTime);
  }
  return out;
}

// ───────────────────────────────── the one database read ─────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRealDate = (s: string): boolean => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * Every `bookings` row the coach is on, dated in `[start, end]` INCLUSIVE: as the first coach (`teacher_id`) or as an
 * extra coach (`booking_teachers`) — plus, when any of them is a GROUP row, that group's SEAT rows (a second SELECT by
 * `group_id`, so an extra coach's group is not mistaken for an empty one). At most two SELECTs, no write. The
 * status/type rules are NOT applied here — they live in the pure part, so they are testable and so one place decides
 * what counts.
 */
export async function collectRows(teacherId: string, start: string, end: string): Promise<TimetableRow[]> {
  // Lazy: the pure half of this file must be importable (and testable) with no database configured.
  const { and, eq, gte, inArray, lte, or, sql } = await import("drizzle-orm");
  const { alias } = await import("drizzle-orm/pg-core");
  const { db } = await import("../db");
  const { ttBookings, ttBookingTeachers, ttStudents } = await import("../db/pub-timetable");
  // TASK-884: the children's names come in the SAME select by two LEFT JOINs (a row with no child keeps its row; a joined
  // child is `null` as a whole when absent). No extra round trip, and still two SELECTs at most.
  const coStudents = alias(ttStudents, "co_students");
  const columns = {
    id: ttBookings.id,
    date: ttBookings.date,
    startTime: ttBookings.startTime,
    endTime: ttBookings.endTime,
    bookingType: ttBookings.bookingType,
    status: ttBookings.status,
    groupId: ttBookings.groupId,
    otherKind: ttBookings.otherKind,
    coStudentId: ttBookings.coStudentId,
    slotYieldedAt: ttBookings.slotYieldedAt,
    student: { id: ttStudents.id, name: ttStudents.name, nickname: ttStudents.nickname },
    coStudent: { id: coStudents.id, name: coStudents.name, nickname: coStudents.nickname },
  };
  const mine: TimetableRow[] = await db
    .select(columns)
    .from(ttBookings)
    .leftJoin(ttStudents, eq(ttBookings.studentId, ttStudents.id))
    .leftJoin(coStudents, eq(ttBookings.coStudentId, coStudents.id))
    .where(
      and(
        gte(ttBookings.date, start),
        lte(ttBookings.date, end),
        or(
          eq(ttBookings.teacherId, teacherId),
          sql`exists (select 1 from ${ttBookingTeachers} where ${ttBookingTeachers.bookingId} = ${ttBookings.id} and ${ttBookingTeachers.teacherId} = ${teacherId})`,
        ),
      ),
    );

  // [Q3] "is this GROUP row empty?" needs its SEATS, and the seats are not always this coach's rows: they carry the
  // group's first coach, so an EXTRA coach on the group would never see them and the group would always look empty.
  // So the seats of every group row returned are fetched by the group id, whoever their `teacher_id` is. They are only
  // used to tell live from empty: a seat is never counted itself.
  const groupIds = mine.filter((r) => r.bookingType === "GROUP" && !r.groupId).map((r) => r.id);
  if (!groupIds.length) return mine;
  const have = new Set(mine.map((r) => r.id));
  const seats: TimetableRow[] = await db
    .select(columns)
    .from(ttBookings)
    .leftJoin(ttStudents, eq(ttBookings.studentId, ttStudents.id))
    .leftJoin(coStudents, eq(ttBookings.coStudentId, coStudents.id))
    .where(inArray(ttBookings.groupId, groupIds));
  return [...mine, ...seats.filter((s) => !have.has(s.id))];
}

/**
 * The contract (SPEC-101 §5, exact): a coach's teaching minutes per Asia/Bangkok calendar day per class type, for
 * `[start, end]` INCLUSIVE. One entry per day that has teaching; days without are omitted (link 3 reads a missing day
 * as zero). Integer minutes everywhere.
 *
 * `collect` is injectable only so the composition (validation · range guard · ordering · omission) is testable
 * without a database; production callers pass three arguments.
 */
export async function readHours(
  teacherId: string,
  start: string,
  end: string,
  collect: (teacherId: string, start: string, end: string) => Promise<TimetableRow[]> = collectRows,
): Promise<HoursDay[]> {
  if (!UUID_RE.test(teacherId)) throw badRequest("teacherId must be a uuid");
  if (!isRealDate(start) || !isRealDate(end)) throw badRequest("start and end must be real dates, YYYY-MM-DD");
  if (start > end) throw badRequest("start must not be after end");
  const rows = await collect(teacherId, start, end);
  // Belt and braces for the inclusive edges: the SELECT already bounds the dates, and this makes the contract true of
  // whatever a `collect` returns.
  return bucketMinutes(rows.filter((r) => r.date >= start && r.date <= end));
}
