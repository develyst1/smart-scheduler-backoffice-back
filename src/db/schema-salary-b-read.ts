// TASK-863 (REQ-120 R1.2, SPEC-100 §9b) — READ-ONLY declarations of the scheduling tables the Bonus 50 / 100 candidates
// reader SELECTs. Team B's file (the TASK renamed it so `schema-salary-b.ts` stays for TASK-868's real `bo` tables).
//
// 🔴 THESE TABLES ARE `smart-scheduler-back`'s (schema `public`). BB never writes them, never migrates them, never adds
// an FK to them — the same ownership rule as `schema.ts`'s `pub*` block and `pub-timetable.ts`. This file is
// deliberately NOT listed in `drizzle.config.ts`: `public` is outside `schemaFilter` (`["ops","bo"]`), so no migration can
// ever come from it, and `drizzle-kit` in this repo never sees it.
// 🚫 Only the columns the reader SELECTs are declared. A column added "for later" is a column that can drift from its
// owner with nobody noticing; add it when a reader needs it.
//
// Names are `sb*` so they never collide with `schema.ts`'s narrower `pub*` declarations or `pub-timetable.ts`'s `tt*`.
import { boolean, date, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** `course_packages` — a sold course. F4 (TASK-860, SB migration `0074`) stores the facts the Bonus lines read. */
export const sbCourses = pgTable("course_packages", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id"),
  /** Set ⇒ a DUO course (the second child). */
  coStudentId: uuid("co_student_id"),
  subjectId: uuid("subject_id"),
  /** SALE | IMPORT — only SALE rows are bonus-eligible (an import is history, not a sale). */
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  // ── F4 facts (all nullable; written at the sale / at day-end) ──
  /** The 1st Trial booking this purchase converted. */
  fromTrialBookingId: uuid("from_trial_booking_id"),
  /** The child's previous entitlement, either kind (at most one of the two is set). */
  prevCourseId: uuid("prev_course_id"),
  prevVoucherId: uuid("prev_voucher_id"),
  /** The coach on the first ATTENDED session (the day-end stamps it). NULL ⇒ never attended. */
  firstTeacherId: uuid("first_teacher_id"),
  /** Set when the WHOLE course changed coach. */
  coachChangedAt: timestamp("coach_changed_at", { withTimezone: true }),
  latestTeacherId: uuid("latest_teacher_id"),
  /** The admin's Special Case pick for Bonus 100 after a coach change: FIRST | LATEST | SHARE. */
  bonus100Pick: text("bonus100_pick"),
});

/** `vouchers` — a sold voucher. It has the F4 conversion facts but no coach-change / pick columns. */
export const sbVouchers = pgTable("vouchers", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id"),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  fromTrialBookingId: uuid("from_trial_booking_id"),
  prevCourseId: uuid("prev_course_id"),
  prevVoucherId: uuid("prev_voucher_id"),
  firstTeacherId: uuid("first_teacher_id"),
});

/** `bookings` — the 1st Trial being converted, and a previous entitlement's sessions (for its first ATTENDED date). */
export const sbBookings = pgTable("bookings", {
  id: uuid("id").primaryKey(),
  teacherId: uuid("teacher_id").notNull(),
  subjectId: uuid("subject_id"),
  date: date("date", { mode: "string" }).notNull(),
  status: text("status").notNull(),
  courseId: uuid("course_id"),
  voucherId: uuid("voucher_id"),
});

export const sbStudents = pgTable("students", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  nickname: text("nickname"),
});

/** `teachers` — only whether a coach is the system teacher ("No Teacher", TASK-861), which is never a bonus coach. */
export const sbTeachers = pgTable("teachers", {
  id: uuid("id").primaryKey(),
  isSystem: boolean("is_system").notNull(),
});

export const sbSubjects = pgTable("subjects", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});
