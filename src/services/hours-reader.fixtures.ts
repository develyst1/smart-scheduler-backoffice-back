// TASK-872 — timetable shapes for the hours reader's tests. Each fixture is a situation that exists in the
// scheduling timetable, names the Step 0 rule it pins (TASK-872 Implementation Notes), and states what the reader must
// answer. Plain data: no database, no clock. Rows are shaped exactly as `collectRows` returns them.
import type { HoursDay, TimetableRow } from "./hours-reader";

let n = 0;
/** A timetable row. Defaults to a confirmed Private hour on 2026-10-14 (a Wednesday). */
export function row(over: Partial<TimetableRow> = {}): TimetableRow {
  n += 1;
  return {
    id: `b-${n}`,
    date: "2026-10-14",
    startTime: "10:00:00",
    endTime: "11:00:00",
    bookingType: "COURSE_PACKAGE",
    status: "ATTENDED",
    groupId: null,
    otherKind: null,
    coStudentId: null,
    slotYieldedAt: null,
    ...over,
  };
}

const day = (date: string, byType: Partial<HoursDay["byType"]>): HoursDay => {
  const full = { private: 0, duo: 0, group: 0, eca: 0, camp: 0, ...byType };
  return { date, byType: full, teachingMinutesTotal: full.private + full.duo + full.group + full.eca + full.camp };
};
export { day };

export interface Fixture {
  name: string;
  /** The Step 0 rule this pins. */
  rule: string;
  rows: TimetableRow[];
  expect: HoursDay[];
}

const D = "2026-10-14";

export const FIXTURES: Fixture[] = [
  // ── the class types ──
  {
    name: "a Private course hour",
    rule: "private = a lesson row with no second child and no group",
    rows: [row()],
    expect: [day(D, { private: 60 })],
  },
  {
    name: "a first trial and a voucher session are Privates",
    rule: "[Q6] FIRST_TRIAL / SINGLE_SESSION / VOUCHER are private",
    rows: [
      row({ bookingType: "FIRST_TRIAL", startTime: "09:00:00", endTime: "10:00:00" }),
      row({ bookingType: "VOUCHER", startTime: "11:00:00", endTime: "12:00:00" }),
      row({ bookingType: "SINGLE_SESSION", startTime: "13:00:00", endTime: "14:00:00" }),
    ],
    expect: [day(D, { private: 180 })],
  },
  {
    name: "a DUO course in its own slot (a second child)",
    rule: "duo = a lesson row with co_student_id set",
    rows: [row({ coStudentId: "kid-2" })],
    expect: [day(D, { duo: 60 })],
  },
  {
    name: "a GROUP with 3 seats is counted ONCE, not once per child",
    rule: "seats (group_id set) never count; the GROUP row counts once by its own minutes",
    rows: (() => {
      const g = row({ id: "g-1", bookingType: "GROUP", otherKind: "GROUP" });
      return [g, row({ groupId: "g-1" }), row({ groupId: "g-1" }), row({ groupId: "g-1", bookingType: "VOUCHER" })];
    })(),
    expect: [day(D, { group: 60 })],
  },
  {
    name: "a DUO group row with its two seats is one duo hour (no double count with the seated DUO course)",
    rule: "GROUP row kind DUO = duo; its seats (even DUO course rows with co_student_id) are excluded",
    rows: (() => {
      const g = row({ id: "g-2", bookingType: "GROUP", otherKind: "DUO" });
      return [g, row({ groupId: "g-2", coStudentId: "kid-2" }), row({ groupId: "g-2", coStudentId: "kid-4" })];
    })(),
    expect: [day(D, { duo: 60 })],
  },
  {
    name: "[Q3] a GROUP row with no child at all is NOT counted",
    rule: "REQ-105 §5 #4 (Khwan): an empty group frees the coach — the GROUP row counts only while it has a live seat",
    rows: [row({ bookingType: "GROUP", otherKind: "GROUP" })],
    expect: [],
  },
  {
    name: "[Q3] a GROUP row whose every seat is on leave, cancelled or still PENDING is NOT counted",
    rule: "a seat is live only in a counted status (CONFIRMED / ATTENDED / NO_SHOW)",
    rows: (() => {
      const g = row({ id: "g-3", bookingType: "GROUP", otherKind: "GROUP" });
      return [g, row({ groupId: "g-3", status: "SICK_LEAVE" }), row({ groupId: "g-3", status: "CANCELLED" }), row({ groupId: "g-3", status: "PENDING" })];
    })(),
    expect: [],
  },
  {
    name: "[Q3] a GROUP row with ONE live seat among dead ones is counted once",
    rule: "one live child is enough; the dead seats neither count nor hide the live one",
    rows: (() => {
      const g = row({ id: "g-4", bookingType: "GROUP", otherKind: "GROUP" });
      return [g, row({ groupId: "g-4", status: "CANCELLED" }), row({ groupId: "g-4", status: "NO_SHOW" }), row({ groupId: "g-4", status: "SICK_LEAVE" })];
    })(),
    expect: [day(D, { group: 60 })],
  },
  {
    name: "[Q3] a seat belongs to ITS group: another group's live seat does not make this one live",
    rule: "liveness is by group_id, not by date or time",
    rows: (() => {
      const empty = row({ id: "g-5", bookingType: "GROUP", otherKind: "GROUP", startTime: "09:00:00", endTime: "10:00:00" });
      const full = row({ id: "g-6", bookingType: "GROUP", otherKind: "GROUP", startTime: "11:00:00", endTime: "12:00:00" });
      return [empty, full, row({ groupId: "g-6" })];
    })(),
    expect: [day(D, { group: 60 })],
  },
  {
    name: "[Q3] an empty DUO group row is not counted either",
    rule: "the emptiness rule covers both GROUP kinds",
    rows: [row({ bookingType: "GROUP", otherKind: "DUO" })],
    expect: [],
  },
  {
    name: "an ECA class (90 min)",
    rule: "eca = OTHER with other_kind ECA",
    rows: [row({ bookingType: "OTHER", otherKind: "ECA", startTime: "15:00:00", endTime: "16:30:00" })],
    expect: [day(D, { eca: 90 })],
  },
  {
    name: "a camp day is one derived 60-minute row per coach per hour",
    rule: "camp = OTHER with other_kind CAMP (camp.service syncCampDayRows: one row per coach per hour, born CONFIRMED)",
    rows: [9, 10, 11, 13, 14].map((h) =>
      row({ bookingType: "OTHER", otherKind: "CAMP", status: "CONFIRMED", startTime: `${String(h).padStart(2, "0")}:00:00`, endTime: `${String(h + 1).padStart(2, "0")}:00:00` }),
    ),
    expect: [day(D, { camp: 300 })],
  },

  // ── the statuses ──
  {
    name: "cancelled, sick leave, paused and pending-reschedule are excluded",
    rule: "[Q1] only CONFIRMED / ATTENDED / NO_SHOW count",
    rows: ["CANCELLED", "SICK_LEAVE", "PAUSED", "PENDING_RESCHEDULE"].map((status) => row({ status })),
    expect: [],
  },
  {
    name: "[Q1] a never-confirmed PENDING or EXTENDED row is excluded",
    rule: "the day-end never settles PENDING / EXTENDED, so they are not a class the coach was confirmed for",
    rows: [row({ status: "PENDING" }), row({ status: "EXTENDED" })],
    expect: [],
  },
  {
    name: "a child no-show with the coach present counts (both ways it is stored)",
    rule: "REQ-120 §9.4 #3: the hour counts for the coach — the day-end writes ATTENDED; legacy rows say NO_SHOW",
    rows: [row({ status: "NO_SHOW", startTime: "10:00:00", endTime: "11:00:00" }), row({ status: "ATTENDED", startTime: "12:00:00", endTime: "13:00:00" })],
    expect: [day(D, { private: 120 })],
  },
  {
    name: "a make-up class is an ordinary class",
    rule: "is_makeup is not a filter: a make-up is born CONFIRMED and counts like any other",
    rows: [row({ status: "CONFIRMED" }), row({ status: "ATTENDED", startTime: "14:00:00", endTime: "15:00:00" })],
    expect: [day(D, { private: 120 })],
  },

  // ── several coaches, yielded groups, non-teaching ──
  {
    name: "an OTHER (ECA) with 2 coaches: the row is returned for each, and each gets the whole row",
    rule: "extras in booking_teachers each get the row's full minutes",
    rows: [row({ bookingType: "OTHER", otherKind: "ECA" })], // collectRows returns this same row for coach A and for coach B
    expect: [day(D, { eca: 60 })],
  },
  {
    name: "[Q4] a yielded GROUP row does not count; the Private that took its hour does",
    rule: "slot_yielded_at set ⇒ the coach-hour is the Private's, never both",
    rows: [
      row({ bookingType: "GROUP", otherKind: "GROUP", slotYieldedAt: "2026-10-10T03:00:00Z" }),
      row({ bookingType: "SINGLE_SESSION" }),
    ],
    expect: [day(D, { private: 60 })],
  },
  {
    name: "[Q2] meeting / maintenance (no kind), FREE and KOL are not teaching class types",
    rule: "OTHER with other_kind null, FREE or KOL is not one of the five types",
    rows: [row({ bookingType: "OTHER", otherKind: null }), row({ bookingType: "OTHER", otherKind: "FREE" }), row({ bookingType: "OTHER", otherKind: "KOL" })],
    expect: [],
  },

  // ── arithmetic, sums, shape ──
  {
    name: "one day with every type sums into teachingMinutesTotal",
    rule: "teachingMinutesTotal = the sum of byType; integer minutes",
    rows: [
      row({ startTime: "09:00:00", endTime: "09:45:00" }), // private 45
      row({ coStudentId: "kid-2", startTime: "10:00:00", endTime: "11:00:00" }), // duo 60
      row({ id: "g-all", bookingType: "GROUP", otherKind: "GROUP", startTime: "12:00:00", endTime: "13:00:00" }), // group 60 …
      row({ groupId: "g-all", startTime: "12:00:00", endTime: "13:00:00" }), // … with one live seat (Q3)
      row({ bookingType: "OTHER", otherKind: "ECA", startTime: "14:00:00", endTime: "15:30:00" }), // eca 90
      row({ bookingType: "OTHER", otherKind: "CAMP", status: "CONFIRMED", startTime: "16:00:00", endTime: "17:00:00" }), // camp 60
    ],
    expect: [day(D, { private: 45, duo: 60, group: 60, eca: 90, camp: 60 })],
  },
  {
    name: "a class ending late the same evening (no midnight crossing)",
    rule: "minutes = end − start within the calendar day",
    rows: [row({ startTime: "22:00:00", endTime: "23:30:00" })],
    expect: [day(D, { private: 90 })],
  },
  {
    name: "two days come back in date order, an idle day in between is omitted",
    rule: "one entry per day with teaching, ascending, none for an empty day",
    rows: [row({ date: "2026-10-16" }), row({ date: "2026-10-14" })],
    expect: [day("2026-10-14", { private: 60 }), day("2026-10-16", { private: 60 })],
  },
];

/** Rows for the period-edge test: the first and last day are INSIDE `[2026-10-01, 2026-10-31]`, the day before and after are OUT. */
export const EDGE_RANGE = { start: "2026-10-01", end: "2026-10-31" } as const;
export const EDGE_ROWS: TimetableRow[] = [
  row({ date: "2026-09-30" }),
  row({ date: "2026-10-01" }),
  row({ date: "2026-10-31" }),
  row({ date: "2026-11-01" }),
];
