CREATE TABLE "catalog_totals" (
	"family" text NOT NULL,
	"value" text NOT NULL,
	"total" integer NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalog_totals_family_value_pk" PRIMARY KEY("family","value")
);
--> statement-breakpoint
CREATE INDEX "bottle_aliases_alias_trgm_idx" ON "bottle_aliases" USING gin (lower(regexp_replace("alias", '[''’.-]', '', 'g')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "bottles_name_trgm_idx" ON "bottles" USING gin (lower(regexp_replace("name", '[''’.-]', '', 'g')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "bottles_distillery_idx" ON "bottles" USING btree ("distillery_id");--> statement-breakpoint
CREATE INDEX "bottles_status_country_idx" ON "bottles" USING btree ("status","country");--> statement-breakpoint
CREATE INDEX "bottles_status_region_idx" ON "bottles" USING btree ("status","region");--> statement-breakpoint
CREATE INDEX "bottles_status_category_idx" ON "bottles" USING btree ("status","category");--> statement-breakpoint
CREATE INDEX "distilleries_name_trgm_idx" ON "distilleries" USING gin (lower(regexp_replace("name", '[''’.-]', '', 'g')) gin_trgm_ops);