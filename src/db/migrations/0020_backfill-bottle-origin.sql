-- Custom migration (drizzle-kit generate --custom): data backfill for catalogs
-- that predate bottles.country (added in 0019). Deploys apply migrations but
-- never reseed (scripts/build.mjs), so rows written before that release keep
-- country NULL and may hold a country name in region ("Scotland" on a blend)
-- unless the rollout itself repairs them. Every statement keys on
-- country IS NULL or region = country, so re-running is a no-op.

-- 1) Inherit the distillery's country — the rule bottleOrigin() applies at
-- seed time (src/db/seed/data.ts).
UPDATE "bottles" SET "country" = "distilleries"."country"
FROM "distilleries"
WHERE "bottles"."distillery_id" = "distilleries"."id" AND "bottles"."country" IS NULL;
--> statement-breakpoint

-- 2) A region that is really a country name moves over whole ("Scotland" on a
-- blend, "Ireland" on a sourced bottling). The list is every country the seed
-- and ingest sources can produce; region is nulled by step 4.
UPDATE "bottles" SET "country" = "region"
WHERE "country" IS NULL AND "region" IN (
  'Scotland', 'England', 'Wales', 'Ireland', 'USA', 'United States', 'Canada',
  'Japan', 'Taiwan', 'India', 'Sweden', 'Norway', 'Denmark', 'Finland',
  'Iceland', 'Germany', 'France', 'Netherlands', 'Belgium', 'Switzerland',
  'Austria', 'Italy', 'Spain', 'Czechia', 'Australia', 'New Zealand',
  'South Africa', 'Israel'
);
--> statement-breakpoint

-- 3) Geographically defined categories imply the country (categoryCountry()
-- in src/lib/origin.ts): bourbon is US by law, Scotch is Scottish, and so on.
-- Covers imported rows that never had a distillery or a usable region. "rye"
-- and "world" stay NULL rather than guessing — except the two seeded ryes we
-- know are American (SEED_BOTTLES declares them explicitly).
UPDATE "bottles" SET "country" = CASE
  WHEN "category" IN ('bourbon', 'american-single-malt', 'american-other') THEN 'USA'
  WHEN "category" IN ('scotch-single-malt', 'scotch-blended') THEN 'Scotland'
  WHEN "category" = 'irish' THEN 'Ireland'
  WHEN "category" = 'japanese' THEN 'Japan'
  WHEN "category" = 'canadian' THEN 'Canada'
END
WHERE "country" IS NULL
  AND "category" IN ('bourbon', 'american-single-malt', 'american-other',
    'scotch-single-malt', 'scotch-blended', 'irish', 'japanese', 'canadian');
--> statement-breakpoint

UPDATE "bottles" SET "country" = 'USA'
WHERE "country" IS NULL AND "id" IN ('redemption-rye', 'templeton-rye-4');
--> statement-breakpoint

-- 4) A region that merely repeats the country is the old single-column habit,
-- not a region (bottleOrigin() drops these at seed time too).
UPDATE "bottles" SET "region" = NULL WHERE "region" = "country";
