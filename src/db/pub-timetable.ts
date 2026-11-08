// SPEC-101 §5 / TASK-872 — READ-ONLY declarations of the scheduling timetable, for the hours reader.
//
// 🔴 THESE TABLES ARE `smart-scheduler-back`'s (schema `public`). BB never writes them, never migrates them, never
// adds an FK to them — the same ownership rule as `schema.ts`'s `pub*` block. This file is deliberately NOT listed in
// `drizzle.config.ts` (and `schemaFilter` is `["ops","bo"]` anyway), so `drizzle-kit` in this repo can never see it.
// 🚫 Only the columns the reader SELECTs are declared. A column added here "for later" is a column that can drift from
// the owner's table with nobody noticing; add it when a reader needs it.
//
// The enum columns (`booking_type`, `status`) are declared as `text`: the reader only reads them as strings, and
// declaring SB's Postgres enums here would be a second copy of a list SB owns. The reader's rules name the values.
//
// Names are `tt*` (timetable) so they never collide with `schema.ts`'s own, narrower `pubBookings` (the report join).
import { date, pgTable, primaryKey, text, time, timestamp, uuid } from "drizzle-orm/pg-core";

export const ttBookings = pgTable("bookings", {
  id: uuid("id").primaryKey(),
  /** The FIRST (and for every lesson, the only) coach. Extra coaches are in `booking_teachers`. */
  teacherId: uuid("teacher_id").notNull(),
  /** Asia/Bangkok calendar date (a plain `date`, returned as `YYYY-MM-DD`). */
  date: date("date", { mode: "string" }).notNull(),
  /** `time` returned as `HH:MM:SS`. */
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  /** FIRST_TRIAL · SINGLE_SESSION · COURSE_PACKAGE · VOUCHER · OTHER · GROUP */
  bookingType: text("booking_type").notNull(),
  /** PENDING · CONFIRMED · ATTENDED · SICK_LEAVE · NO_SHOW · EXTENDED · PENDING_RESCHEDULE · CANCELLED · PAUSED */
  status: text("status").notNull(),
  /** Set ⇒ this row is a SEAT of a GROUP row (it holds no coach slot). */
  groupId: uuid("group_id"),
  /** OTHER: ECA · FREE · KOL · CAMP. GROUP: DUO · GROUP. Lessons: NULL. */
  otherKind: text("other_kind"),
  /** A DUO course row's second child; NULL otherwise. */
  coStudentId: uuid("co_student_id"),
  /** Set ⇒ a GROUP row that gave its coach-hour to a Private. */
  slotYieldedAt: timestamp("slot_yielded_at", { withTimezone: true }),
});

/** The ADDITIONAL coaches on an OTHER / GROUP row (the first coach is `bookings.teacher_id`). */
export const ttBookingTeachers = pgTable(
  "booking_teachers",
  {
    bookingId: uuid("booking_id").notNull(),
    teacherId: uuid("teacher_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.teacherId] })],
);
