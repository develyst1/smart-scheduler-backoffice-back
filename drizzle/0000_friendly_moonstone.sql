CREATE SCHEMA "ops";
--> statement-breakpoint
CREATE TYPE "ops"."account_unit" AS ENUM('HOURS', 'CURRENCY', 'POINTS');--> statement-breakpoint
CREATE TYPE "ops"."ledger_direction" AS ENUM('CREDIT', 'DEBIT');--> statement-breakpoint
CREATE TYPE "ops"."notify_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "ops"."party_kind" AS ENUM('PERSON', 'ORGANIZATION');--> statement-breakpoint
CREATE TYPE "ops"."price_rule_kind" AS ENUM('HOURLY', 'FIXED', 'PERCENTAGE', 'CAP');--> statement-breakpoint
CREATE TYPE "ops"."request_kind" AS ENUM('TOP_UP', 'PURCHASE', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "ops"."request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "ops"."settlement_line_kind" AS ENUM('LABOR', 'COMMISSION', 'TRAVEL', 'EXPENSE', 'OTHER');--> statement-breakpoint
CREATE TYPE "ops"."settlement_status" AS ENUM('DRAFT', 'FINAL', 'VOID');--> statement-breakpoint
CREATE TYPE "ops"."stock_direction" AS ENUM('IN', 'OUT', 'ADJUST');--> statement-breakpoint
CREATE TABLE "ops"."account_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" "ops"."ledger_direction" NOT NULL,
	"amount_minor" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text,
	"ref_type" text,
	"ref_id" text,
	"idempotency_key" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_ledger_amount_chk" CHECK ("ops"."account_ledger"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "ops"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"unit" "ops"."account_unit" NOT NULL,
	"currency_code" text,
	"balance_minor" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."api_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."catalog_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"sale_price_minor" integer DEFAULT 0 NOT NULL,
	"track_stock" boolean DEFAULT true NOT NULL,
	"reorder_level" integer,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."commercial_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" "ops"."request_kind" NOT NULL,
	"status" "ops"."request_status" DEFAULT 'PENDING' NOT NULL,
	"payload" jsonb NOT NULL,
	"review_note" text,
	"reviewed_by_party_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text DEFAULT 'line' NOT NULL,
	"recipient_ref" text,
	"payload" jsonb NOT NULL,
	"status" "ops"."notify_status" DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"ref_type" text,
	"ref_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"display_name" text NOT NULL,
	"kind" "ops"."party_kind" DEFAULT 'PERSON' NOT NULL,
	"external_ref" text,
	"external_source" text,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."price_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"party_id" uuid,
	"kind" "ops"."price_rule_kind" NOT NULL,
	"label" text,
	"amount_minor" integer NOT NULL,
	"cap_minor" integer,
	"currency_code" text DEFAULT 'THB',
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"line_kind" "ops"."settlement_line_kind" NOT NULL,
	"quantity_minor" integer DEFAULT 0 NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency_code" text DEFAULT 'THB' NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"note" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."settlement_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"status" "ops"."settlement_status" DEFAULT 'DRAFT' NOT NULL,
	"note" text,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."stock_balances" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"direction" "ops"."stock_direction" NOT NULL,
	"quantity" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"reason" text,
	"ref_type" text,
	"ref_id" text,
	"idempotency_key" text,
	"actor_party_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_qty_chk" CHECK ("ops"."stock_movements"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "ops"."account_ledger" ADD CONSTRAINT "account_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."accounts" ADD CONSTRAINT "accounts_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "ops"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."catalog_items" ADD CONSTRAINT "catalog_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "ops"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."commercial_requests" ADD CONSTRAINT "commercial_requests_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "ops"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."commercial_requests" ADD CONSTRAINT "commercial_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "ops"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."commercial_requests" ADD CONSTRAINT "commercial_requests_reviewed_by_party_id_parties_id_fk" FOREIGN KEY ("reviewed_by_party_id") REFERENCES "ops"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."parties" ADD CONSTRAINT "parties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "ops"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."price_rules" ADD CONSTRAINT "price_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "ops"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."price_rules" ADD CONSTRAINT "price_rules_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "ops"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."settlement_lines" ADD CONSTRAINT "settlement_lines_run_id_settlement_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "ops"."settlement_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."settlement_lines" ADD CONSTRAINT "settlement_lines_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "ops"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."settlement_runs" ADD CONSTRAINT "settlement_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "ops"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_balances" ADD CONSTRAINT "stock_balances_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "ops"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_movements" ADD CONSTRAINT "stock_movements_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "ops"."catalog_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."stock_movements" ADD CONSTRAINT "stock_movements_actor_party_id_parties_id_fk" FOREIGN KEY ("actor_party_id") REFERENCES "ops"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_ledger_idempotency_uq" ON "ops"."account_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "account_ledger_account_idx" ON "ops"."account_ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "accounts_party_idx" ON "ops"."accounts" USING btree ("party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_party_unit_currency_uq" ON "ops"."accounts" USING btree ("party_id","unit","currency_code");--> statement-breakpoint
CREATE UNIQUE INDEX "api_credentials_prefix_uq" ON "ops"."api_credentials" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_items_org_sku_uq" ON "ops"."catalog_items" USING btree ("organization_id","sku");--> statement-breakpoint
CREATE INDEX "catalog_items_org_idx" ON "ops"."catalog_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "commercial_requests_status_idx" ON "ops"."commercial_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_key_uq" ON "ops"."idempotency_records" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_code_uq" ON "ops"."organizations" USING btree ("code");--> statement-breakpoint
CREATE INDEX "parties_org_idx" ON "ops"."parties" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "parties_external_idx" ON "ops"."parties" USING btree ("external_source","external_ref");--> statement-breakpoint
CREATE INDEX "price_rules_party_idx" ON "ops"."price_rules" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_run_idx" ON "ops"."settlement_lines" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "settlement_runs_org_period_idx" ON "ops"."settlement_runs" USING btree ("organization_id","period_from");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_idempotency_uq" ON "ops"."stock_movements" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "ops"."stock_movements" USING btree ("item_id","created_at");