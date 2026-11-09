CREATE TABLE "bo"."school" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"distance_km" numeric(8, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "school_distance_ck" CHECK ("distance_km" > 0)
);
--> statement-breakpoint
CREATE TABLE "bo"."transport_trip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"date" date NOT NULL,
	"school_id" uuid NOT NULL,
	"round_trip" boolean DEFAULT true NOT NULL,
	"km" numeric(8, 2) NOT NULL,
	"vehicle" "bo"."vehicle",
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transport_trip_km_ck" CHECK ("km" > 0)
);
--> statement-breakpoint
ALTER TABLE "bo"."transport_trip" ADD CONSTRAINT "transport_trip_school_id_school_id_fk" FOREIGN KEY ("school_id") REFERENCES "bo"."school"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bo_school_name_uq" ON "bo"."school" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "bo_transport_trip_teacher_date_idx" ON "bo"."transport_trip" USING btree ("teacher_id","date");