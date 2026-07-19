import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { searchBottlesLike, type BottleSearchResult } from "@/lib/ai/tools";

/**
 * Barcode (UPC/EAN) resolution for the scan flow — docs/DATA_SOURCES.md §3.
 *
 * Resolution order: own DB first (seeded + user-confirmed mappings), then a
 * transient external lookup (UPCitemdb trial → Open Food Facts) whose result
 * is only used to fuzzy-match our own catalog — external data is never
 * persisted (ODbL isolation). The user's confirmation is what creates the
 * durable upc→bottle mapping, so every scan grows first-party data.
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

const EXTERNAL_TIMEOUT_MS = 3000;

export interface ExternalUpcProduct {
  /** Product name as reported by the external source. */
  name: string;
  provider: "upcitemdb" | "openfoodfacts";
}

/** External lookups are on unless explicitly disabled (or in unit tests without a fetch mock). */
export function isExternalLookupEnabled(): boolean {
  return process.env.WHAIKEY_UPC_LOOKUP !== "off";
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Look up a UPC against free external sources, best effort: UPCitemdb's
 * trial endpoint first (best liquor coverage per docs/DATA_SOURCES.md), then
 * Open Food Facts. Returns the product name only — used transiently to
 * search our catalog, never stored (ODbL + API-ToS compliance). Any network
 * error, timeout, or miss returns null; scanning must degrade gracefully.
 */
export async function lookupExternalUpc(upc: string): Promise<ExternalUpcProduct | null> {
  try {
    const data = (await fetchJson(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`,
    )) as { items?: Array<{ title?: string; brand?: string }> } | null;
    const item = data?.items?.[0];
    const title = item?.title?.trim();
    if (title) return { name: title, provider: "upcitemdb" };
  } catch {
    // fall through to the next provider
  }

  try {
    const data = (await fetchJson(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json?fields=product_name,brands`,
    )) as { product?: { product_name?: string; brands?: string } } | null;
    const name = [data?.product?.brands, data?.product?.product_name]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(" ");
    if (name) return { name, provider: "openfoodfacts" };
  } catch {
    // both providers failed — that's fine
  }

  return null;
}

/**
 * Turn an external product name into catalog candidates. Product titles are
 * noisy ("Buffalo Trace Kentucky Straight Bourbon Whiskey 750ml"), so we try
 * progressively shorter prefixes of the meaningful words until something hits.
 */
export async function candidatesFromExternalName(
  db: DB,
  name: string,
): Promise<BottleSearchResult[]> {
  const NOISE = /^(the|whiskey|whisky|bourbon|scotch|single|malt|straight|kentucky|tennessee|irish|blended|750ml|700ml|1l|liter|litre|proof|year|yr|old)$/i;
  const words = name
    .split(/[^a-zA-Z0-9']+/)
    .filter((w) => w.length > 1 && !NOISE.test(w) && !/^\d+m?l?$/i.test(w));

  for (let take = Math.min(4, words.length); take >= 1; take--) {
    const query = words.slice(0, take).join(" ");
    const results = await searchBottlesLike(db, query, undefined, 5);
    if (results.length > 0) return results;
  }
  return [];
}
