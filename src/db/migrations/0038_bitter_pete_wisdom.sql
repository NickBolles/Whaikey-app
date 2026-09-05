ALTER TABLE "analytics_events" DROP CONSTRAINT "analytics_events_share_id_pour_shares_id_fk";
--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_share_id_pour_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."pour_shares"("id") ON DELETE set null ON UPDATE no action;