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
