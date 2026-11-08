// SPEC-098 §2 / TASK-858 — the revenue ledger (REQ-120 §2). A NEW file, on purpose: `schema.ts` belongs to Team A's
// TASK-856 this week. drizzle-kit finds this file through the array in `drizzle.config.ts`.
//
// The tables live in the existing `bo` pgSchema object (imported, read-only) — there is no second `pgSchema("bo")`.
// Amounts are signed integer satang, like `bo.movement.value_minor`; a refund is a negative line (type 'REFUND').
import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bo } from "./schema";

export const boRevenueCategory = bo.table(
  "revenue_category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(), // one of the 8 revenue types (never REFUND)
    name: text("name").notNull(), // e.g. 'Inline Skate · Private', '10 Hr', 'STA'
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Bare column names, exactly as SPEC-098 §2 writes them: `${t.col}` would emit "bo"."revenue_category"."type",
    // a form that could not be tried against Postgres from the engineer's seat.
    check("revenue_category_type_ck", sql`"type" IN ('COURSE','TRIAL','VOUCHER','ECA','SALES','FNB','RENT','OTHER')`),
    uniqueIndex("bo_revenue_category_type_name_uq").on(t.type, sql`lower(${t.name})`),
  ],
);

export const boRevenueLine = bo.table(
  "revenue_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(), // the date it COUNTS (R2.2), Asia/Bangkok calendar date
    branch: text("branch").notNull(), // 'BRAVO' | 'OTHER' (R2.4)
    type: text("type").notNull(), // 8 types + 'REFUND'
    categoryId: uuid("category_id").references(() => boRevenueCategory.id), // NULL only for REFUND
    productName: text("product_name").notNull(), // R2.5 "Product Name"
    amountMinor: integer("amount_minor").notNull(), // signed satang; REFUND < 0, every other type > 0
    method: text("method").notNull(), // 'TRANSFER' | 'CASH' | 'CARD' (R2.4)
    remark: text("remark"),
    source: text("source").notNull(), // 'MANUAL' now; later 'BOOKING' | 'ECA' | 'STOCK' | 'REFUND' | 'RENT'
    refType: text("ref_type"),
    refId: text("ref_id"), // what produced it (NULL for MANUAL)
    idempotencyKey: text("idempotency_key"), // writers that may retry set it; MANUAL leaves it NULL
    actor: text("actor"), // who saved it (the JWT subject; NULL for service writers)
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("revenue_line_branch_ck", sql`"branch" IN ('BRAVO','OTHER')`),
    check("revenue_line_method_ck", sql`"method" IN ('TRANSFER','CASH','CARD')`),
    check(
      "revenue_line_type_ck",
      sql`"type" IN ('COURSE','TRIAL','VOUCHER','ECA','SALES','FNB','RENT','OTHER','REFUND')`,
    ),
    check(
      "revenue_line_sign_ck",
      sql`("type" = 'REFUND' AND "amount_minor" < 0) OR ("type" <> 'REFUND' AND "amount_minor" > 0)`,
    ),
    uniqueIndex("bo_revenue_line_idempotency_uq").on(t.idempotencyKey),
    index("bo_revenue_line_day_idx").on(t.occurredOn, t.type),
  ],
);

export type BoRevenueCategory = typeof boRevenueCategory.$inferSelect;
export type BoRevenueLine = typeof boRevenueLine.$inferSelect;

// ── SPEC-099 §8 / TASK-874 — the F2 payment record (REQ-120 F2, slice 2a: COURSE and VOUCHER) ────────────────────────
// ONE table, BB-owned and migrated here, written by BOTH apps (the back office through /revenue/payments, the front office
// directly from smart-scheduler-back at the sale): the same pattern as `revenue_line` (SPEC-098 §1). It is a `bo` table, not
// a `public` one, because BB never writes `public` (`schema.ts` l.591-601). `ref_id` is a plain uuid: NO FK to `public`.
//   n = 1 → the sale's own payment (created automatically at the sale, TRANSFER, the whole fee); n >= 2 → installments.
//   Installments SPLIT the one fee (§8.9): the API keeps sum(rows) <= the sale's net. Revenue is NOT changed by any of it
//   (row 13: the whole amount counts at confirm); the revenue line's METHOD follows row 1 (§8.4).
export const boPayment = bo.table(
  "payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    refType: text("ref_type").notNull(), // 'COURSE' | 'VOUCHER' in slice 2a; 'BOOKING' | 'CAMP' | 'RENTAL' later
    refId: uuid("ref_id").notNull(), // course_packages.id / vouchers.id — no FK (public is SB's)
    n: integer("n").notNull(), // 1 = the sale's own payment; 2.. = installments
    paidOn: date("paid_on", { mode: "string" }).notNull(), // the Asia/Bangkok date the money came in
    amountMinor: integer("amount_minor").notNull(), // satang, > 0
    method: text("method").notNull(), // 'TRANSFER' | 'CASH' | 'CARD'
    actor: text("actor"), // who last set it (JWT sub / SB staff id); NULL for the auto row
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Bare column names, as in `revenue_line`'s CHECKs (see the note there).
    check("payment_ref_type_ck", sql`"ref_type" IN ('COURSE','VOUCHER','BOOKING','CAMP','RENTAL')`),
    check("payment_method_ck", sql`"method" IN ('TRANSFER','CASH','CARD')`),
    check("payment_amount_ck", sql`"amount_minor" > 0`),
    check("payment_n_ck", sql`"n" >= 1`),
    uniqueIndex("bo_payment_ref_n_uq").on(t.refType, t.refId, t.n),
  ],
);

export type BoPayment = typeof boPayment.$inferSelect;
