-- Idempotent on purpose: the flavor backfill CLI (src/lib/ingest/flavor-tiers.ts,
-- ensureFlavorProvenanceTable) creates this exact table before the migration
-- ships, so production may already have it.
CREATE TABLE IF NOT EXISTS "bottle_flavor_provenance" (
	"bottle_id" text PRIMARY KEY NOT NULL,
	"tier" text NOT NULL,
	"confidence" double precision NOT NULL,
	"method" text NOT NULL,
	"model" text,
	"pass" text NOT NULL,
	"input_hash" text,
	"enriched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bottle_flavor_provenance_bottle_id_bottles_id_fk') THEN
    ALTER TABLE "bottle_flavor_provenance" ADD CONSTRAINT "bottle_flavor_provenance_bottle_id_bottles_id_fk" FOREIGN KEY ("bottle_id") REFERENCES "public"."bottles"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bottle_flavor_provenance_tier_idx" ON "bottle_flavor_provenance" USING btree ("tier");
