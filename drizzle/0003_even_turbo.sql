-- TASK-005 / SPEC-002: effective-dated FT/PT recurring salary schedule.
-- NOTE: drizzle-kit's auto-generated diff also re-emitted item_group/item_type/external_*/amount_minor
-- ADDs because the repo's drizzle meta snapshot was drifted from the real DB (those columns already
-- exist from the hand-patched 0001/0002 migrations — see board.md infra note). Those stale re-adds were
-- removed by hand so this migration only creates the genuinely new `recurring_costs` object.
CREATE TABLE "ops"."recurring_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"party_id" uuid,
	"item_id" uuid NOT NULL,
	"label" text,
	"amount_minor" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ops"."recurring_costs" ADD CONSTRAINT "recurring_costs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "ops"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."recurring_costs" ADD CONSTRAINT "recurring_costs_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "ops"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops"."recurring_costs" ADD CONSTRAINT "recurring_costs_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "ops"."catalog_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_costs_org_idx" ON "ops"."recurring_costs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recurring_costs_item_idx" ON "ops"."recurring_costs" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "recurring_costs_effective_idx" ON "ops"."recurring_costs" USING btree ("effective_from","effective_to");
