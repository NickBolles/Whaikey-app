CREATE TABLE "brand_logos" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"distillery_id" text,
	"wikidata_id" text,
	"website" text,
	"status" text DEFAULT 'none' NOT NULL,
	"logo_url" text,
	"logo_source" text,
	"license" text,
	"attribution" text,
	"attribution_url" text,
	"attribution_required" boolean DEFAULT false NOT NULL,
	"content_type" text,
	"logo_data" text,
	"width" integer,
	"height" integer,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bottles" ADD COLUMN "brand_key" text;--> statement-breakpoint
ALTER TABLE "brand_logos" ADD CONSTRAINT "brand_logos_distillery_id_distilleries_id_fk" FOREIGN KEY ("distillery_id") REFERENCES "public"."distilleries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_logos_status_idx" ON "brand_logos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bottles_brand_key_idx" ON "bottles" USING btree ("brand_key");