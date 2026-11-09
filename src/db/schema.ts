// ─────────────────────────────────────────────────────────────────────────────
// Operations / Finance schema — generic ERP primitives (NOT tutoring-specific).
//
// Lives in PostgreSQL schema `ops` so it never collides with scheduling tables
// (students, teachers, bookings, …) in the public schema.
//
// Naming rules:
//  - parties, catalog_items, accounts — reusable for retail, services, etc.
//  - external_ref + external_source — link to any upstream app without coupling
//  - price_rules, settlement_* — not "teacher_rate" / "payroll"
// ─────────────────────────────────────────────────────────────────────────────

import { relations, sql } from "drizzle-orm";
import {
  pgSchema,
  pgTable,
  smallint,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  check,
  primaryKey,
  numeric,
} from "drizzle-orm/pg-core";

export const ops = pgSchema("ops");

// ───────────────────────────── Enums ─────────────────────────────

export const partyKind = ops.enum("party_kind", ["PERSON", "ORGANIZATION"]);
export const stockDirection = ops.enum("stock_direction", ["IN", "OUT", "ADJUST"]);
// Item-centric P&L model: what the item is (group) + how it hits the books (type).
export const itemGroup = ops.enum("item_group", ["PRODUCT", "SERVICE"]);
export const itemType = ops.enum("item_type", ["INCOME", "EXPENSE", "FIXED_COST"]);
export const accountUnit = ops.enum("account_unit", ["HOURS", "CURRENCY", "POINTS"]);
export const ledgerDirection = ops.enum("ledger_direction", ["CREDIT", "DEBIT"]);
export const requestStatus = ops.enum("request_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);
export const requestKind = ops.enum("request_kind", ["TOP_UP", "PURCHASE", "ADJUSTMENT"]);
export const priceRuleKind = ops.enum("price_rule_kind", [
  "HOURLY",
  "FIXED",
  "PERCENTAGE",
  "CAP",
]);
export const settlementStatus = ops.enum("settlement_status", ["DRAFT", "FINAL", "VOID"]);
export const settlementLineKind = ops.enum("settlement_line_kind", [
  "LABOR",
  "COMMISSION",
  "TRAVEL",
  "EXPENSE",
  "OTHER",
]);
export const notifyStatus = ops.enum("notify_status", [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED",
]);

// ───────────────────────────── Org (multi-business ready) ─────────────────────────────

export const organizations = ops.table(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("organizations_code_uq").on(t.code)],
);

// ───────────────────────────── Parties (customers, workers, vendors) ─────────────────────────────

export const parties = ops.table(
  "parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    displayName: text("display_name").notNull(),
    kind: partyKind("kind").notNull().default("PERSON"),
    /** Opaque id in an upstream system, e.g. scheduling user uuid */
    externalRef: text("external_ref"),
    /** Upstream app id, e.g. `smart-scheduler` — not a table name */
    externalSource: text("external_source"),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("parties_org_idx").on(t.organizationId),
    index("parties_external_idx").on(t.externalSource, t.externalRef),
  ],
);

// ───────────────────────────── Catalog / inventory ─────────────────────────────

export const catalogItems = ops.table(
  "catalog_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull().default("each"),
    // P&L classification. group = PRODUCT|SERVICE (what it is), type = how it books:
    // INCOME (revenue on sale), EXPENSE (variable cost, e.g. freelance hour), FIXED_COST (monthly).
    itemGroup: itemGroup("item_group").notNull().default("PRODUCT"),
    itemType: itemType("item_type").notNull().default("INCOME"),
    // Per-unit amount in minor units (satang): sale price for INCOME, unit cost for EXPENSE/FIXED_COST.
    salePriceMinor: integer("sale_price_minor").notNull().default(0),
    trackStock: boolean("track_stock").notNull().default(true),
    reorderLevel: integer("reorder_level"),
    // Optional link to an upstream entity (e.g. a scheduling teacher or course code) so a
    // consumer can decrement "the item for teacher X" without knowing its uuid. Same
    // decoupling pattern as parties — no FK across systems.
    externalRef: text("external_ref"),
    externalSource: text("external_source"),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("catalog_items_org_sku_uq").on(t.organizationId, t.sku),
    index("catalog_items_org_idx").on(t.organizationId),
    index("catalog_items_external_idx").on(t.externalSource, t.externalRef),
  ],
);

export const stockBalances = ops.table("stock_balances", {
  itemId: uuid("item_id")
    .primaryKey()
    .references(() => catalogItems.id, { onDelete: "cascade" }),
  quantityOnHand: integer("quantity_on_hand").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const stockMovements = ops.table(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => catalogItems.id, { onDelete: "restrict" }),
    direction: stockDirection("direction").notNull(),
    quantity: integer("quantity").notNull(),
    quantityAfter: integer("quantity_after").notNull(),
    // Baht value (minor units) this movement contributes to the P&L. Revenue for INCOME
    // items, cost for EXPENSE/FIXED_COST. Defaults to quantity × item unit amount.
    amountMinor: integer("amount_minor").notNull().default(0),
    reason: text("reason"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    idempotencyKey: text("idempotency_key"),
    actorPartyId: uuid("actor_party_id").references(() => parties.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("stock_movements_qty_chk", sql`${t.quantity} > 0`),
    uniqueIndex("stock_movements_idempotency_uq").on(t.idempotencyKey),
    index("stock_movements_item_idx").on(t.itemId, t.createdAt),
  ],
);

// ───────────────────────────── Accounts (wallet / credits) ─────────────────────────────

export const accounts = ops.table(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    unit: accountUnit("unit").notNull(),
    /** ISO 4217 when unit = CURRENCY */
    currencyCode: text("currency_code"),
    balanceMinor: integer("balance_minor").notNull().default(0),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("accounts_party_idx").on(t.partyId),
    uniqueIndex("accounts_party_unit_currency_uq").on(t.partyId, t.unit, t.currencyCode),
  ],
);

export const accountLedger = ops.table(
  "account_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    direction: ledgerDirection("direction").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    idempotencyKey: text("idempotency_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("account_ledger_amount_chk", sql`${t.amountMinor} > 0`),
    uniqueIndex("account_ledger_idempotency_uq").on(t.idempotencyKey),
    index("account_ledger_account_idx").on(t.accountId, t.createdAt),
  ],
);

// ───────────────────────────── Admin-mediated commercial requests ─────────────────────────────

export const commercialRequests = ops.table(
  "commercial_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    kind: requestKind("kind").notNull(),
    status: requestStatus("status").notNull().default("PENDING"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    reviewNote: text("review_note"),
    reviewedByPartyId: uuid("reviewed_by_party_id").references(() => parties.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("commercial_requests_status_idx").on(t.status, t.createdAt)],
);

// ───────────────────────────── Pricing (generic rate cards) ─────────────────────────────

export const priceRules = ops.table(
  "price_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "cascade" }),
    kind: priceRuleKind("kind").notNull(),
    label: text("label"),
    amountMinor: integer("amount_minor").notNull(),
    capMinor: integer("cap_minor"),
    currencyCode: text("currency_code").default("THB"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("price_rules_party_idx").on(t.partyId)],
);

// ───────────────────────────── Recurring costs (effective-dated fixed salary) ─────────────────────────────
// SPEC-002: per-teacher recurring monthly FIXED_COST salary schedule. A change closes the prior
// open row (effective_to = month before the new effective_from) and inserts a new row, so past
// months stay frozen and a materialize of any month reads the amount in effect *then*.

export const recurringCosts = ops.table(
  "recurring_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    // Optional link to the ops party for the teacher; the FIXED_COST item (external_ref=teacherId)
    // is the real anchor, matching the party-less freelance model.
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "set null" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => catalogItems.id, { onDelete: "restrict" }),
    label: text("label"),
    amountMinor: integer("amount_minor").notNull(),
    // First day of the effective month; effective_to = last active month (null = open-ended).
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("recurring_costs_org_idx").on(t.organizationId),
    index("recurring_costs_item_idx").on(t.itemId),
    index("recurring_costs_effective_idx").on(t.effectiveFrom, t.effectiveTo),
  ],
);

// ───────────────────────────── Settlement (payroll-like, generic) ─────────────────────────────

export const settlementRuns = ops.table(
  "settlement_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    periodFrom: timestamp("period_from", { withTimezone: true }).notNull(),
    periodTo: timestamp("period_to", { withTimezone: true }).notNull(),
    status: settlementStatus("status").notNull().default("DRAFT"),
    note: text("note"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("settlement_runs_org_period_idx").on(t.organizationId, t.periodFrom)],
);

export const settlementLines = ops.table(
  "settlement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => settlementRuns.id, { onDelete: "cascade" }),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),
    lineKind: settlementLineKind("line_kind").notNull(),
    quantityMinor: integer("quantity_minor").notNull().default(0),
    amountMinor: integer("amount_minor").notNull(),
    currencyCode: text("currency_code").notNull().default("THB"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    note: text("note"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("settlement_lines_run_idx").on(t.runId)],
);

// ───────────────────────────── API access & idempotency ─────────────────────────────

export const apiCredentials = ops.table(
  "api_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("api_credentials_prefix_uq").on(t.keyPrefix)],
);

export const idempotencyRecords = ops.table(
  "idempotency_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: jsonb("response_body").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idempotency_records_key_uq").on(t.key)],
);

export const notificationOutbox = ops.table("notification_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  channel: text("channel").notNull().default("line"),
  recipientRef: text("recipient_ref"),
  payload: jsonb("payload").notNull(),
  status: notifyStatus("status").notNull().default("PENDING"),
  error: text("error"),
  refType: text("ref_type"),
  refId: text("ref_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

// ───────────────────────────── Relations ─────────────────────────────

export const organizationsRelations = relations(organizations, ({ many }) => ({
  parties: many(parties),
  catalogItems: many(catalogItems),
}));

export const partiesRelations = relations(parties, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [parties.organizationId],
    references: [organizations.id],
  }),
  accounts: many(accounts),
}));

export const catalogItemsRelations = relations(catalogItems, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [catalogItems.organizationId],
    references: [organizations.id],
  }),
  balance: one(stockBalances, {
    fields: [catalogItems.id],
    references: [stockBalances.itemId],
  }),
  movements: many(stockMovements),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  party: one(parties, { fields: [accounts.partyId], references: [parties.id] }),
  ledger: many(accountLedger),
}));

// ═════════════════════════════════════════════════════════════════════════════
// REQ-006 backoffice rebuild — universal item/movement model in a NEW `bo` schema
// (same PostgreSQL). Everything is an `item` (direction × cadence, optional ceiling)
// and quantity moves via signed `movement`. Grouping via tags. No roles/approvals.
// The old `ops.*` above is left DORMANT (referenced by the data migration, TASK-025).
// ═════════════════════════════════════════════════════════════════════════════

export const bo = pgSchema("bo");

export const boDirection = bo.enum("direction", ["INCOME", "EXPENSE"]);
export const boCadence = bo.enum("cadence", [
  "VARIABLE",
  "FIXED_MONTHLY",
  "FIXED_DAILY",
  "FIXED_QUARTERLY",
]);

export const boItem = bo.table(
  "item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    unit: text("unit").notNull().default("each"), // free-text (hour, month, piece, …)
    direction: boDirection("direction").notNull(), // INCOME | EXPENSE (fixed after create)
    cadence: boCadence("cadence").notNull().default("VARIABLE"),
    ceilingQty: integer("ceiling_qty"), // optional cap (e.g. monthly freelance hours)
    remainingQty: integer("remaining_qty"), // current remaining under the ceiling
    unitPriceMinor: integer("unit_price_minor").notNull().default(0), // money per unit (satang)
    // 🔻 TASK-909 / 904 companion (`0018`, DECISIONS row 21) — the revenue category a sale of this product posts into (bo.revenue_category.id). Nullable; NO drizzle FK here (schema-revenue.ts imports this file: a reference would be a cycle) — the FK is in the migration.
    revenueCategoryId: uuid("revenue_category_id"),
    commissionGroup: text("commission_group"), // 🔻 TASK-904 (`0015`) — a stock product's commission group NAME (nullable; the picker + R3.5 read it)
    ownerRef: text("owner_ref"), // e.g. scheduling teacherId — teacher identity ONLY, never a product code
    externalSource: text("external_source"), // e.g. 'smart-scheduler'
    // Product code for sale posting: "course-6" / "voucher-10" / "first-trial" / "single-session"
    // (TASK-066). Unique with external_source. Deliberately separate from ownerRef — one column,
    // one meaning.
    externalRef: text("external_ref"),
    active: boolean("active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("bo_item_owner_idx").on(t.externalSource, t.ownerRef)],
);

export const boMovement = bo.table(
  "movement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => boItem.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull(), // signed: + in / − out
    remainingAfter: integer("remaining_after"),
    valueMinor: integer("value_minor").notNull().default(0), // |qty| × unit_price → P&L
    reason: text("reason"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    idempotencyKey: text("idempotency_key"),
    // SPEC-059 / TASK-159 (REQ-063): a discount movement records the money; these record the DECISION behind
    // it — who authorised it and what it was for (`โปรวันแม่`). Nullable + additive (`0006`): every existing
    // movement is untouched, and nothing reads them until TASK-160 starts writing them.
    actor: text("actor"),
    note: text("note"),
    /** 🔻 TASK-911 (`0017`) - the BUSINESS day (Asia/Bangkok): Stock IN = receivedOn, Stock OUT = the sale's day, import = the apply day. NULL on legacy rows (the report falls back to created_at). */
    occurredOn: date("occurred_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bo_movement_idempotency_uq").on(t.idempotencyKey),
    index("bo_movement_item_idx").on(t.itemId, t.createdAt),
  ],
);

// 🔻 TASK-909 (`0016`, REQ-120 R3.5) — the Stock OUT sale record. A header (who sold, when, where, how it was paid) and its lines (what left stock, at what price,
// with what discount and commission AS GIVEN), each line linked to the SALE movement it wrote. `branch` / `method` / `buyer_ref` / `remark` are forward-looking: the
// Revenue posting and the commission layer read them, so neither re-migrates. Money is integer satang; nothing here is a total.
export const boSale = bo.table(
  "sale",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    branch: text("branch").notNull().default("BRAVO"),
    method: text("method"), // 'TRANSFER' | 'CASH' | 'CARD' | NULL (not said yet)
    buyerRef: text("buyer_ref"),
    remark: text("remark"),
    sellerRefs: jsonb("seller_refs").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    actor: text("actor"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bo_sale_idempotency_uq").on(t.idempotencyKey),
    check("bo_sale_branch_ck", sql`${t.branch} IN ('BRAVO','OTHER')`),
    check("bo_sale_method_ck", sql`${t.method} IS NULL OR ${t.method} IN ('TRANSFER','CASH','CARD')`),
  ],
);

export const boSaleLine = bo.table(
  "sale_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id").notNull().references(() => boSale.id, { onDelete: "restrict" }),
    itemId: uuid("item_id").notNull().references(() => boItem.id, { onDelete: "restrict" }),
    qty: integer("qty").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    discountMinor: integer("discount_minor").notNull().default(0),
    commissionMinor: integer("commission_minor").notNull().default(0),
    movementId: uuid("movement_id").notNull().references(() => boMovement.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("bo_sale_line_movement_uq").on(t.movementId),
    check("bo_sale_line_qty_ck", sql`${t.qty} > 0`),
    check("bo_sale_line_money_ck", sql`${t.unitPriceMinor} >= 0 AND ${t.discountMinor} >= 0 AND ${t.commissionMinor} >= 0 AND ${t.discountMinor} <= ${t.qty} * ${t.unitPriceMinor}`),
  ],
);

export const boTagGroup = bo.table("tag_group", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const boTagValue = bo.table("tag_value", {
  id: uuid("id").primaryKey().defaultRandom(),
  tagGroupId: uuid("tag_group_id")
    .notNull()
    .references(() => boTagGroup.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  color: text("color"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const boItemTag = bo.table(
  "item_tag",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => boItem.id, { onDelete: "cascade" }),
    tagValueId: uuid("tag_value_id")
      .notNull()
      .references(() => boTagValue.id, { onDelete: "cascade" }),
    tagGroupId: uuid("tag_group_id")
      .notNull()
      .references(() => boTagGroup.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.tagValueId] }),
    uniqueIndex("bo_item_tag_group_uq").on(t.itemId, t.tagGroupId),
  ],
);

export const boItemRelations = relations(boItem, ({ many }) => ({
  movements: many(boMovement),
  itemTags: many(boItemTag),
}));

export const boMovementRelations = relations(boMovement, ({ one }) => ({
  item: one(boItem, { fields: [boMovement.itemId], references: [boItem.id] }),
}));

export const boTagValueRelations = relations(boTagValue, ({ one }) => ({
  group: one(boTagGroup, { fields: [boTagValue.tagGroupId], references: [boTagGroup.id] }),
}));

export const boItemTagRelations = relations(boItemTag, ({ one }) => ({
  item: one(boItem, { fields: [boItemTag.itemId], references: [boItem.id] }),
  value: one(boTagValue, { fields: [boItemTag.tagValueId], references: [boTagValue.id] }),
}));

// ── R0.1 users + roles (SPEC-097 / TASK-856 / REQ-120) ──────────────────────────────────────────────────────────
// The back office's OWN sign-in table. `ops.accounts` / `bo.*` money tables are NOT users. Roles are exactly these
// three, lower-case, and match `final-ui`'s `Role` (carry-over contract for all three teams).
export const boRole = bo.enum("role", ["ceo", "admin", "coach"]);

export const boUsers = bo.table(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Trimmed + lower-cased on write; the login key and the token `sub`. */
    username: text("username").notNull(),
    /** `Bun.password` argon2id (the same primitive the front office uses). Never in any response. */
    passwordHash: text("password_hash").notNull(),
    role: boRole("role").notNull(),
    /**
     * The scheduling teacher this coach IS (scopes "own slip"). A plain uuid on purpose — NO FK to `public.teachers`:
     * `public` is owned and migrated by smart-scheduler-back (same ownership rule as `bo.item.owner_ref`), and a
     * cross-owner FK would let this table block a teacher delete over there. NULL for ceo / admin.
     */
    teacherId: uuid("teacher_id"),
    active: boolean("active").notNull().default(true),
    /**
     * TASK-930 (`0021`) — the front-office user this row ADMITS (`public.users.id`). A plain uuid, NO FK (`public` is smart-scheduler-back's). Set ⇒ sign-in verifies
     * against the LIVE front-office hash + `disabled_at` (same login as the front office); NULL ⇒ a back-office-own row (the env-seeded CEO), verified on its own hash.
     */
    foUserId: uuid("fo_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("bo_users_username_uq").on(t.username),
    uniqueIndex("bo_users_fo_user_id_uq").on(t.foUserId).where(sql`${t.foUserId} is not null`),
  ],
);

// ── Thin-slip pay-run + slip engine (SPEC-100 / TASK-865) ───────────────────────────────────────────────────────
// A pay period is one calendar month; a slip is one coach in one period; a slip's total is `base_amount + Σ lines`
// and is NEVER stored (computed on read). Every later pay line (Extra Hour, OT, Merit, Bonus, Commission, FL pay,
// Transportation) is another `pay_line_kind` on the same model. `teacher_id` is a plain uuid with NO cross-schema FK
// (`public.teachers` belongs to smart-scheduler-back — the SPEC-097 house pattern). Money columns are `numeric(14,2)` baht;
// the code computes in integer satang and never in float.
export const boEmploymentType = bo.enum("employment_type", ["FT", "PT", "FL", "STAFF"]);
export const boPayPeriodStatus = bo.enum("pay_period_status", ["open", "locked"]);
export const boPaySlipStatus = bo.enum("pay_slip_status", ["draft", "confirmed", "locked"]);
export const boPayLineKind = bo.enum("pay_line_kind", [
  "base",
  "other",
  "extra_hour",
  "ot",
  "merit",
  "bonus",
  "commission",
  "fl_pay",
  "transport",
]);
export const boPayLineSource = bo.enum("pay_line_source", ["manual", "auto"]);
// TASK-871 / SPEC-101 §4 — the class-type dimension shared by the FL rates (here) and the hours reader (link 2), and the vehicle.
export const boPayClassType = bo.enum("pay_class_type", ["private", "duo", "group", "eca", "camp"]);
export const boVehicle = bo.enum("vehicle", ["car", "motorbike"]);

/** One row per coach. Base is CEO-only data; null ⇒ 0 on a slip. */
export const boSalaryProfile = bo.table(
  "salary_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teacherId: uuid("teacher_id").notNull(),
    employmentType: boEmploymentType("employment_type").notNull().default("FT"),
    /** R1.1 — the set of roles held; EMPTY ⇒ just `employment_type`. The only multi-role combination is PT + FL (FL Mon–Fri, PT Sat–Sun: `lib/role-of-day.ts`). */
    roles: boEmploymentType("roles").array().notNull().default(sql`'{}'`),
    baseSalary: numeric("base_salary", { precision: 14, scale: 2 }),
    /** R1.2 — eligible for a Merit line (the amount itself is typed; no auto compute). */
    meritEligible: boolean("merit_eligible").notNull().default(false),
    /** R1.2 — for Team B's Transportation (defined here so the people model is whole). */
    vehicle: boVehicle("vehicle"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("bo_salary_profile_teacher_uq").on(t.teacherId)],
);

/** R1.2 — a freelance hourly RATE per person AND per class type (satang per hour, as numeric baht). One row per (profile, class type). */
export const boFlRate = bo.table(
  "fl_rate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => boSalaryProfile.id, { onDelete: "cascade" }),
    classType: boPayClassType("class_type").notNull(),
    rate: numeric("rate", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("bo_fl_rate_profile_class_uq").on(t.profileId, t.classType)],
);

export const boPayPeriod = bo.table(
  "pay_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    /** R1.4 — the period runs period_start..period_end INCLUSIVE ("30/9–30/10"): `lib/pay-period.ts`. `year`/`month` stay the human label. NULL on rows made before TASK-871. */
    periodStart: date("period_start", { mode: "string" }),
    periodEnd: date("period_end", { mode: "string" }),
    status: boPayPeriodStatus("status").notNull().default("open"),
    /** The auto-lock instant; default = 12:00 Asia/Bangkok on the last day of (year, month) (REQ-120 R1.5). */
    lockAt: timestamp("lock_at", { withTimezone: true }).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("bo_pay_period_ym_uq").on(t.year, t.month),
    check("bo_pay_period_month_chk", sql`${t.month} between 1 and 12`),
  ],
);

export const boPaySlip = bo.table(
  "pay_slip",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => boPayPeriod.id),
    teacherId: uuid("teacher_id").notNull(),
    /** Snapshot of `salary_profile.base_salary` at run time. */
    baseAmount: numeric("base_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    status: boPaySlipStatus("status").notNull().default("draft"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("bo_pay_slip_period_teacher_uq").on(t.periodId, t.teacherId)],
);

export const boPaySlipLine = bo.table(
  "pay_slip_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slipId: uuid("slip_id")
      .notNull()
      .references(() => boPaySlip.id, { onDelete: "cascade" }),
    kind: boPayLineKind("kind").notNull(),
    /** For `other`: the REQUIRED reason (REQ-120 R1.4). */
    label: text("label").notNull(),
    /** SIGNED — an Other ± line may be negative. */
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    source: boPayLineSource("source").notNull().default("manual"),
    /**
     * TASK-867/878 — what an AUTO line was derived from (e.g. a date, an ECA/bonus key), so a re-run upserts instead of duplicating.
     * Nullable: a manual line has none. The partial unique index below makes (slip, kind, source_ref) unique among `source = 'auto'` lines.
     */
    sourceRef: text("source_ref"),
    /** 🔻 TASK-903 (SPEC-101 §6, `0014`) - the class type of a `fl_pay` line (one line per FL date x class). NULL for every other kind. */
    classType: boPayClassType("class_type"),
    /** The CEO username from the token. */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("bo_pay_slip_line_slip_idx").on(t.slipId),
    uniqueIndex("bo_pay_slip_line_auto_ref_uq").on(t.slipId, t.kind, t.sourceRef).where(sql`${t.source} = 'auto'`),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY declarations of the scheduling app's `public` tables (SPEC-021 / TASK-064).
//
// ⚠️ OWNERSHIP RULE — backoffice-back **READS** these and **never writes or migrates them**.
// `public` migrations stay owned by smart-scheduler-back. There is one database since REQ-006, so this is a
// plain join; it mirrors the direction REQ-006 already chose (scheduling-back touches `bo.item` directly
// rather than over HTTP), so it is the established pattern here, not a new liberty.
//
// Only the columns the revenue-attribution join actually needs are declared — a narrow declaration can't
// tempt anyone into writing through it, and it won't drift when scheduling-back adds a column.
// ─────────────────────────────────────────────────────────────────────────────

export const pubStudents = pgTable("students", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  nickname: text("nickname"),
});

export const pubSubjects = pgTable("subjects", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

export const pubCoursePackages = pgTable("course_packages", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id").notNull(),
  size: smallint("size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const pubVouchers = pgTable("vouchers", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id").notNull(),
  totalHours: smallint("total_hours").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const pubBookings = pgTable("bookings", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
  courseId: uuid("course_id"),
  date: date("date").notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔻 TASK-924 / SPEC-103 — READ-ONLY declarations for the All Report API (both halves: STUDENT here, COURSE + REPORT in TASK-926).
//
// ⚠️ Same ownership rule as above: backoffice-back READS these, never writes or migrates `public`. Named `rp*` and
// declared apart from the `pub*` block on purpose: those serve the revenue join and other seats' tests pin them.
// Only the columns SPEC-103 §2–§4 read. Enum columns (status, booking_type, source, branch) are read as plain text.
// ─────────────────────────────────────────────────────────────────────────────

export const rpParents = pgTable("parents", {
  id: uuid("id").primaryKey(),
  phone: text("phone").notNull(),
  name: text("name"),
  province: text("province"),
});

export const rpStudents = pgTable("students", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  nickname: text("nickname"),
  parentId: uuid("parent_id"),
  gender: text("gender"),
  birthDate: date("birth_date"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const rpSubjects = pgTable("subjects", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
});

export const rpCourses = pgTable("course_packages", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id"),
  coStudentId: uuid("co_student_id"),
  size: smallint("size").notNull(),
  subjectId: uuid("subject_id"),
  usedSessions: smallint("used_sessions").notNull(),
  priorSessions: smallint("prior_sessions").notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  droppedAt: timestamp("dropped_at", { withTimezone: true }),
  expiryDate: date("expiry_date").notNull(),
  source: text("source").notNull(),
  fromTrialBookingId: uuid("from_trial_booking_id"),
  branch: text("branch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

// A voucher has NO subject_id and NO dropped_at (SB schema.ts ~429): never "paused"; its activity comes from its bookings.
export const rpVouchers = pgTable("vouchers", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id").notNull(),
  totalHours: smallint("total_hours").notNull(),
  usedHours: smallint("used_hours").notNull(),
  expiryDate: date("expiry_date").notNull(),
  source: text("source").notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  fromTrialBookingId: uuid("from_trial_booking_id"),
  branch: text("branch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const rpBookings = pgTable("bookings", {
  id: uuid("id").primaryKey(),
  studentId: uuid("student_id").notNull(),
  subjectId: uuid("subject_id").notNull(),
  date: date("date").notNull(),
  bookingType: text("booking_type").notNull(),
  status: text("status").notNull(),
  courseId: uuid("course_id"),
  voucherId: uuid("voucher_id"),
  branch: text("branch"),
});
