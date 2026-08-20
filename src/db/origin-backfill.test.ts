import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { setupTestDb } from "@/test/helpers";
import type { DB } from "@/db";

/**
 * Migration 0020 repairs catalogs written before bottles.country existed:
 * production applies migrations but never reseeds (scripts/build.mjs), so the
 * rollout itself must set country on existing rows and stop the region column
 * reporting "Scotland". These tests run the actual migration file against
 * legacy-shaped rows — the exact SQL a deployment executes.
 */

const MIGRATION = readFileSync(
  path.join(process.cwd(), "src", "db", "migrations", "0020_backfill-bottle-origin.sql"),
  "utf8",
);

async function runBackfill(db: DB): Promise<void> {
  for (const statement of MIGRATION.split("--> statement-breakpoint")) {
    await db.execute(sql.raw(statement));
  }
}

async function bottleOrigins(db: DB): Promise<Record<string, { country: string | null; region: string | null }>> {
  const rows = await db
    .select({ id: schema.bottles.id, country: schema.bottles.country, region: schema.bottles.region })
    .from(schema.bottles);
  return Object.fromEntries(rows.map((r) => [r.id, { country: r.country, region: r.region }]));
}

describe("0020 origin backfill", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
    await db.insert(schema.distilleries).values({
      id: "lagavulin",
      name: "Lagavulin",
      country: "Scotland",
      region: "Islay",
    });
    // Legacy-shaped rows: country was never set, and region held whatever was
    // handy — a real region, a US state, or a whole country.
    await db.insert(schema.bottles).values([
      { id: "lagavulin-16", name: "Lagavulin 16", category: "scotch-single-malt", distilleryId: "lagavulin", country: null, region: "Islay" },
      { id: "johnnie-walker-black", name: "Johnnie Walker Black", category: "scotch-blended", country: null, region: "Scotland" },
      { id: "jeffersons-ocean", name: "Jefferson's Ocean", category: "bourbon", country: null, region: "Kentucky" },
      { id: "templeton-rye-4", name: "Templeton Rye 4 Year", category: "rye", country: null, region: "Iowa" },
      { id: "mystery-import", name: "Mystery Rye", category: "rye", country: null, region: null, status: "imported" },
      { id: "world-import", name: "Somewhere Single Malt", category: "world", country: null, region: null, status: "imported" },
    ]);
  });

  it("backfills every recoverable country and strips countries out of region", async () => {
    await runBackfill(db);
    expect(await bottleOrigins(db)).toEqual({
      // Inherited from the distillery, sub-national region kept.
      "lagavulin-16": { country: "Scotland", region: "Islay" },
      // The blend that used to masquerade as a region.
      "johnnie-walker-black": { country: "Scotland", region: null },
      // Geographically defined category implies the country; the state stays.
      "jeffersons-ocean": { country: "USA", region: "Kentucky" },
      // Seeded rye, declared by id because "rye" alone is ambiguous.
      "templeton-rye-4": { country: "USA", region: "Iowa" },
      // Unknown-origin imports are left alone rather than guessed at.
      "mystery-import": { country: null, region: null },
      "world-import": { country: null, region: null },
    });
  });

  it("is idempotent and leaves already-correct rows untouched", async () => {
    await runBackfill(db);
    const first = await bottleOrigins(db);
    await runBackfill(db);
    expect(await bottleOrigins(db)).toEqual(first);
  });
});
