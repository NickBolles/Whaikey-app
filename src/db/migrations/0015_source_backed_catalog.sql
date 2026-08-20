CREATE TABLE "bottle_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"value_hash" text NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bottle_media" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"alt" text,
	"rights" text NOT NULL,
	"attribution" text,
	"width" integer,
	"height" integer,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bottle_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"bottle_id" text NOT NULL,
	"source_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"publisher" text,
	"content_hash" text,
	"match_method" text DEFAULT 'manifest' NOT NULL,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"fetch_policy" text DEFAULT 'structured' NOT NULL,
	"media_policy" text DEFAULT 'review_required' NOT NULL,
	"attribution" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bottle_claims" ADD CONSTRAINT "bottle_claims_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_claims" ADD CONSTRAINT "bottle_claims_resource_id_bottle_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."bottle_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_media" ADD CONSTRAINT "bottle_media_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_media" ADD CONSTRAINT "bottle_media_resource_id_bottle_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."bottle_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_resources" ADD CONSTRAINT "bottle_resources_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bottle_resources" ADD CONSTRAINT "bottle_resources_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_claims_resource_field_value_uq" ON "bottle_claims" USING btree ("resource_id","field","value_hash");--> statement-breakpoint
CREATE INDEX "bottle_claims_bottle_idx" ON "bottle_claims" USING btree ("bottle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_media_bottle_url_uq" ON "bottle_media" USING btree ("bottle_id","url");--> statement-breakpoint
CREATE INDEX "bottle_media_bottle_idx" ON "bottle_media" USING btree ("bottle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bottle_resources_bottle_url_uq" ON "bottle_resources" USING btree ("bottle_id","url");--> statement-breakpoint
CREATE INDEX "bottle_resources_bottle_idx" ON "bottle_resources" USING btree ("bottle_id");--> statement-breakpoint
CREATE INDEX "bottle_resources_source_idx" ON "bottle_resources" USING btree ("source_id");