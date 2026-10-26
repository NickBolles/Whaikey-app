-- Idempotent on purpose: the flavor backfill CLI (src/lib/ingest/flavor-tiers.ts,
-- ensureFlavorProvenanceTable) creates/extends the popularity table and the
-- provenance column, so production may already have them when this runs.
CREATE TABLE IF NOT EXISTS "bottle_popularity_daily" (
	"bottle_id" text NOT NULL,
	"day" text NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"scans" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "bottle_popularity_daily_bottle_id_day_pk" PRIMARY KEY("bottle_id","day")
);
--> statement-breakpoint
ALTER TABLE "bottle_flavor_provenance" ADD COLUMN IF NOT EXISTS "replaced_legacy_profile" jsonb;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bottle_popularity_daily_bottle_id_bottles_id_fk') THEN
    ALTER TABLE "bottle_popularity_daily" ADD CONSTRAINT "bottle_popularity_daily_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bottle_popularity_daily_day_idx" ON "bottle_popularity_daily" USING btree ("day");
