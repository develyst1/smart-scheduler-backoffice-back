// 🔻 TASK-917 (REQ-120 R0.4 / R3.7) - notifications, role-derived recipient assignments (ruling C-h: NO opt-out), and the Low-Stock thresholds. A NEW file (found through drizzle.config.ts).
import { sql } from "drizzle-orm";
import { check, date, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bo } from "./schema";

export const NOTIFY_TYPES = ["Bonus", "Commission", "Transportation", "OT", "Other", "Low Stock", "Extra Hour"] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];
const TYPES_SQL = sql`'Bonus','Commission','Transportation','OT','Other','Low Stock','Extra Hour'`;

export const boNotification = bo.table(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The recipient's username (= the token's `sub`). */
    recipientRef: text("recipient_ref").notNull(),
    type: text("type").notNull(),
    /** Plain text, NO money (an admin sees the same item). */
    text: text("text").notNull(),
    occurredOn: date("occurred_on").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    /** Makes a GENERATED item idempotent per recipient (e.g. `low-stock:<monday>:<item>`). NULL for an item with no natural key. */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("bo_notification_recipient_idx").on(t.recipientRef, t.occurredOn),
    uniqueIndex("bo_notification_dedupe_uq").on(t.recipientRef, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
    check("notification_type_ck", sql`"type" IN (${TYPES_SQL})`),
  ],
);

/** Who receives which type. A ROLE ('ceo') or a named USER. Read-only to the app: the seed and a script are the only writers (ruling C-h). */
export const boNotificationAssignment = bo.table(
  "notification_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectKind: text("subject_kind").notNull(),
    subject: text("subject").notNull(),
    type: text("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bo_notification_assignment_uq").on(t.subjectKind, sql`lower(${t.subject})`, t.type),
    check("notification_assignment_kind_ck", sql`"subject_kind" IN ('role','user')`),
    check("notification_assignment_type_ck", sql`"type" IN (${TYPES_SQL})`),
  ],
);

export const boLowStockThreshold = bo.table(
  "low_stock_threshold",
  {
    type: text("type").primaryKey(),
    /** NULL = no alert for this type. */
    threshold: integer("threshold"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check("low_stock_threshold_ck", sql`"threshold" IS NULL OR "threshold" >= 0`)],
);
