// TASK-868 (REQ-120 R1.2 / R1.6, SPEC-100 §3 / §9b) — Team B's `bo` tables for Transportation. A NEW file, on purpose
// (`schema.ts` is Team A's): drizzle-kit finds it through the array in `drizzle.config.ts` (one entry, after Team C's).
//
// The tables live in the existing `bo` pgSchema object (imported, read-only) — there is no second `pgSchema("bo")`.
// `teacher_id` is a plain uuid with NO cross-schema FK (SPEC-097's house pattern: `public.teachers` is SB's).
// `vehicle` is Team A's enum `bo.vehicle` (migration 0010) — imported, never re-declared, so there is one definition.
import { sql } from "drizzle-orm";
import { boolean, check, date, index, numeric, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bo, boVehicle } from "./schema";

/** A school and its stored distance (R1.2: "the system stores each school's distance, editable"). */
export const boSchool = bo.table(
  "school",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** One-way distance in km, at most 2 decimals. */
    distanceKm: numeric("distance_km", { precision: 8, scale: 2 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Bare column names, as in `revenue_line`'s CHECKs: `${t.col}` would emit a qualified name.
    check("school_distance_ck", sql`"distance_km" > 0`),
    // "name (unique)": case-insensitive, so "STA" and "sta" cannot both exist
    uniqueIndex("bo_school_name_uq").on(sql`lower(${t.name})`),
  ],
);

/** One trip of one person to one school: ONE pay line (R1.6, "each trip in full"). */
export const boTransportTrip = bo.table(
  "transport_trip",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id").notNull(),
    /** The Asia/Bangkok calendar date of the trip. */
    date: date("date", { mode: "string" }).notNull(),
    schoolId: uuid("school_id")
      .notNull()
      .references(() => boSchool.id),
    roundTrip: boolean("round_trip").notNull().default(true),
    /** The trip's TOTAL km: defaults to the school's distance × (round trip ? 2 : 1), editable per trip (Q22 default A). */
    km: numeric("km", { precision: 8, scale: 2 }).notNull(),
    /** SNAPSHOT of the person's `salary_profile.vehicle` at entry, so a later profile change never re-prices an old trip. NULL ⇒ no vehicle on file ⇒ no pay line. */
    vehicle: boVehicle("vehicle"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [check("transport_trip_km_ck", sql`"km" > 0`), index("bo_transport_trip_teacher_date_idx").on(t.teacherId, t.date)],
);

export type BoSchool = typeof boSchool.$inferSelect;
export type BoTransportTrip = typeof boTransportTrip.$inferSelect;
