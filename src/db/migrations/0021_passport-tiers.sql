CREATE TABLE "passport_tiers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"family" text NOT NULL,
	"value" text NOT NULL,
	"tier" integer NOT NULL,
	"achieved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passport_tiers" ADD CONSTRAINT "passport_tiers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "passport_tiers_user_badge_tier_uq" ON "passport_tiers" USING btree ("user_id","family","value","tier");--> statement-breakpoint
CREATE INDEX "passport_tiers_user_idx" ON "passport_tiers" USING btree ("user_id");