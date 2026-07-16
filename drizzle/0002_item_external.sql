-- Link catalog items to upstream entities (teacher id / course code) so consumers can
-- decrement an item by external ref without knowing its uuid. No cross-system FK.
ALTER TABLE "ops"."catalog_items" ADD COLUMN IF NOT EXISTS "external_ref" text;--> statement-breakpoint
ALTER TABLE "ops"."catalog_items" ADD COLUMN IF NOT EXISTS "external_source" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_items_external_idx" ON "ops"."catalog_items" ("external_source","external_ref");
