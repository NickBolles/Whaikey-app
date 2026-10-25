CREATE TABLE "upc_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"upc" text NOT NULL,
	"bottle_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upc_lookup_cache" (
	"provider" text NOT NULL,
	"upc" text NOT NULL,
	"found" boolean NOT NULL,
	"product_name" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "upc_lookup_cache_provider_upc_pk" PRIMARY KEY("provider","upc")
);
--> statement-breakpoint
CREATE TABLE "upc_provider_usage" (
	"provider" text NOT NULL,
	"day" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"minute_start" timestamp with time zone,
	"minute_count" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"last_status" integer,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "upc_provider_usage_provider_day_pk" PRIMARY KEY("provider","day")
);
--> statement-breakpoint
ALTER TABLE "upc_confirmations" ADD CONSTRAINT "upc_confirmations_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upc_confirmations" ADD CONSTRAINT "upc_confirmations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upc_confirmations_upc_user_uq" ON "upc_confirmations" USING btree ("upc","user_id");--> statement-breakpoint
CREATE INDEX "upc_confirmations_upc_idx" ON "upc_confirmations" USING btree ("upc");--> statement-breakpoint
CREATE INDEX "upc_confirmations_user_updated_idx" ON "upc_confirmations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "upc_confirmations_status_idx" ON "upc_confirmations" USING btree ("status");