CREATE TABLE "bo"."payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"paid_on" date NOT NULL,
	"amount_minor" integer NOT NULL,
	"method" text NOT NULL,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_ref_type_ck" CHECK ("ref_type" IN ('COURSE','VOUCHER','BOOKING','CAMP','RENTAL')),
	CONSTRAINT "payment_method_ck" CHECK ("method" IN ('TRANSFER','CASH','CARD')),
	CONSTRAINT "payment_amount_ck" CHECK ("amount_minor" > 0),
	CONSTRAINT "payment_n_ck" CHECK ("n" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bo_payment_ref_n_uq" ON "bo"."payment" USING btree ("ref_type","ref_id","n");