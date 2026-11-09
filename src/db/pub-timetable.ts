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
import { date, integer, pgTable, primaryKey, text, time, timestamp, uuid } from "drizzle-orm/pg-core";

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
  /**
   * TASK-884 — the row's child (R1.6 "who was taught"). A lesson row: its child. A GROUP's SEAT: that child. An OTHER (ECA / Free / KOL)
   * row: the one student it was typed with, or NULL (a title-only row; SB's validation.ts:277 wants a student OR a title). The CAMP grid
   * rows are derived and carry none. Nullable in the database (SB migration 0029 dropped the NOT NULL for OTHER).
   */
  studentId: uuid("student_id"),
  /** A DUO course row's second child; NULL otherwise. */
  coStudentId: uuid("co_student_id"),
  /** 🔻 TASK-893 — the course / voucher this session belongs to (the refund sources count attended and still-live sessions per plan). */
  courseId: uuid("course_id"),
  voucherId: uuid("voucher_id"),
  /** Set ⇒ a GROUP row that gave its coach-hour to a Private. */
  slotYieldedAt: timestamp("slot_yielded_at", { withTimezone: true }),
});

/**
 * TASK-884 — a child, for the R1.6 names ONLY: `id`, `name`, `nickname` (the form SB prints: nickname, else name —
 * `smart-scheduler-back` `src/db/mappers.ts:194` `studentNamesOf`). There is NO `is_system` column on `students` (it exists only on
 * `teachers`), so there is nothing to exclude at this level. Never parent, phone or LINE ids.
 */
export const ttStudents = pgTable("students", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  nickname: text("nickname"),
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

/** 🔻 TASK-893 (SPEC-099 §10) — a sold COURSE, read-only: the refund sources list. `ended_at` set ⇒ already cancelled. */
export const ttCoursePackages = pgTable("course_packages", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id"),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

/** 🔻 TASK-893 — a sold VOUCHER, read-only, the same purpose. */
export const ttVouchers = pgTable("vouchers", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id"),
  totalHours: integer("total_hours").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});
