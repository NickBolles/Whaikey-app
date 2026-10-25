import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { searchBottlesLike, type BottleSearchResult } from "@/lib/ai/tools";

/**
 * Barcode (UPC/EAN) resolution for the scan flow — docs/DATA_SOURCES.md §3.
 *
 * Resolution order: own DB first (seeded + crowd-verified mappings), then
 * pending crowd claims (src/lib/upc-crowd.ts), then an external lookup
 * (src/lib/upc-providers.ts: cached, budgeted, backed off) whose result is
 * only used to fuzzy-match our own catalog — provider data is never merged
 * into the catalog (ODbL isolation). Confirmations become a durable
 * upc→bottle mapping once enough independent people agree.
 */

// GTIN normalization & validation live in src/lib/upc.ts (client-safe, no DB
// imports); re-exported here so server code has a single scan entry point.
export { isValidUpc, normalizeUpc } from "@/lib/upc";

// ---------------------------------------------------------------------------
// Own-DB resolution + confirmation (the first-party loop)
// ---------------------------------------------------------------------------

export interface UpcMatch extends BottleSearchResult {
  /** How many users have confirmed this upc→bottle mapping (0 = seed only). */
  confirmedCount: number;
  source: schema.UpcSource;
}

/**
 * Resolve a normalized UPC against our own mappings. Multiple bottles can
 * share a barcode (producers reuse codes across batches/proofs); rows are
 * ordered most-confirmed first so the top match is the community's answer.
 */
export async function resolveUpc(db: DB, upc: string): Promise<UpcMatch[]> {
  return db
    .select({
      id: schema.bottles.id,
      name: schema.bottles.name,
      category: schema.bottles.category,
      country: schema.bottles.country,
      region: schema.bottles.region,
      ageYears: schema.bottles.ageYears,
      abv: schema.bottles.abv,
      msrp: schema.bottles.msrp,
      avgPrice: schema.bottles.avgPrice,
      distillery: schema.distilleries.name,
      confirmedCount: schema.bottleUpcs.confirmedCount,
      source: schema.bottleUpcs.source,
    })
    .from(schema.bottleUpcs)
    .innerJoin(schema.bottles, eq(schema.bottleUpcs.bottleId, schema.bottles.id))
    .leftJoin(schema.distilleries, eq(schema.bottles.distilleryId, schema.distilleries.id))
    .where(eq(schema.bottleUpcs.upc, upc))
    .orderBy(desc(schema.bottleUpcs.confirmedCount), desc(schema.bottleUpcs.updatedAt));
}

/**
 * Record a user's confirmation that `upc` is `bottleId`: inserts the mapping
 * or increments confirmedCount on the existing row. Returns the stored row.
 */
export async function confirmUpcMapping(
  db: DB,
  upc: string,
  bottleId: string,
): Promise<schema.BottleUpc> {
  const [row] = await db
    .insert(schema.bottleUpcs)
    .values({ id: crypto.randomUUID(), upc, bottleId, source: "user", confirmedCount: 1 })
    .onConflictDoUpdate({
      target: [schema.bottleUpcs.upc, schema.bottleUpcs.bottleId],
      set: {
        confirmedCount: sql`${schema.bottleUpcs.confirmedCount} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Transient external lookup (fallback when our DB misses)
// ---------------------------------------------------------------------------

/**
 * The provider registry (whisky API → UPCitemdb → Open Food Facts) with its
 * permanent cache, daily budget and backoff lives in src/lib/upc-providers.ts;
 * re-exported so the scan route keeps a single entry point.
 */
export { lookupExternalUpc, type ExternalUpcProduct } from "@/lib/upc-providers";

/** External lookups are on unless explicitly disabled (or in unit tests without a fetch mock). */
export function isExternalLookupEnabled(): boolean {
  return process.env.WHAIKEY_UPC_LOOKUP !== "off";
}

/**
 * Turn an external product name into catalog candidates. Product titles are
 * noisy ("Buffalo Trace Kentucky Straight Bourbon Whiskey 750ml"), so we try
 * progressively shorter prefixes of the meaningful words until something hits.
 */
export async function candidatesFromExternalName(
  db: DB,
  name: string,
  viewerId?: string,
): Promise<BottleSearchResult[]> {
  const NOISE = /^(the|whiskey|whisky|bourbon|scotch|single|malt|straight|kentucky|tennessee|irish|blended|750ml|700ml|1l|liter|litre|proof|year|yr|old)$/i;
  const words = name
    .split(/[^a-zA-Z0-9']+/)
    .filter((w) => w.length > 1 && !NOISE.test(w) && !/^\d+m?l?$/i.test(w));

  for (let take = Math.min(4, words.length); take >= 1; take--) {
    const query = words.slice(0, take).join(" ");
    const results = await searchBottlesLike(db, query, undefined, 5, viewerId);
    if (results.length > 0) return results;
  }
  return [];
}
