import type { WhiskeyCategory } from "@/db/schema";
import { cleanProductName, looksFlavored, slugify } from "./normalize";
import type { CatalogCandidate } from "./types";

/**
 * Vinmonopolet (Norway) product ingest via the official developer API
 * (docs/SOURCING_AT_SCALE.md §3.1; free key from api.vinmonopolet.no, sent as
 * Ocp-Apim-Subscription-Key — set VINMONOPOLET_API_KEY).
 *
 * The sanctioned products API has been slimmed down to names only
 * (productId + productShortName; no category, ABV, or price fields), and its
 * productShortNameContains filter accepts single words only. So the adapter
 * unions several whisky-signal search terms, filters out non-whisky spirits
 * by name, and infers a conservative category from name cues. The value here
 * is name coverage — European bottlings matched against the catalog, and
 * "sold at a state monopoly" evidence for verification — not attributes.
 * Rows the cues can't place land as "world" and are left for enrichment.
 */

export const VINMONOPOLET_PRODUCTS_URL = "https://apis.vinmonopolet.no/products/v0/details-normal";

/** Single-word name searches unioned to find whisky rows (the API 422s on phrases). */
export const VINMONOPOLET_SEARCH_TERMS = ["whisky", "whiskey", "bourbon", "scotch", "malt", "rye"] as const;

const PAGE_SIZE = 3000;
const MAX_PAGES = 40; // safety backstop per term

/** The subset of API fields the adapter reads. */
export interface VinmonopoletProduct {
  basic?: {
    productId?: string;
    productShortName?: string;
  };
}

/** Name markers for products the searches catch that are not whisky. */
const NON_WHISKY =
  /\b(vodka|gin|aquavit|akevitt|likør|liqueur|rom|rum|cognac|brandy|grappa|mjød|mead|beer|øl|bitter|punsch|sake|shochu|baijiu|malt beverage|maltekstrakt)\b/i;

/** Infer a conservative category from name cues alone (names are all we get). */
export function vinmonopoletCategory(name: string): WhiskeyCategory | null {
  const n = name.toLowerCase();
  if (NON_WHISKY.test(n)) return null;
  // A known Japanese whisky producer is itself a whisky signal — those names
  // often carry no style keyword ("Nikka From The Barrel").
  if (/\b(japanese|suntory|yamazaki|hakushu|hibiki|toki|nikka|yoichi|taketsuru|chichibu)\b/.test(n)) {
    return "japanese";
  }
  const isWhisky = /\b(whisky|whiskey|bourbon|scotch|single malt|malt)\b/.test(n) || /\brye\b/.test(n);
  if (!isWhisky) return null;

  if (/\bbourbon\b/.test(n)) return "bourbon";
  if (/\brye\b/.test(n)) return "rye";
  if (/\btennessee\b/.test(n)) return "american-other";
  if (/\birish\b/.test(n)) return "irish";
  if (/\bcanadian\b/.test(n)) return "canadian";
  if (/\bscotch\b/.test(n)) {
    return /\bsingle malt\b/.test(n) ? "scotch-single-malt" : "scotch-blended";
  }
  // Bare "single malt"/"whisky" with no origin cue: the honest default is
  // "world" — a slug match keeps the curated category anyway, and enrichment
  // can refine unmatched imports later.
  return "world";
}

export interface VinmonopoletAdapterResult {
  scanned: number;
  candidates: CatalogCandidate[];
}

/** Collapse fetched products into deduped whisky candidates (names only). */
export function vinmonopoletProductsToCandidates(
  products: VinmonopoletProduct[],
): VinmonopoletAdapterResult {
  const bySlug = new Map<string, CatalogCandidate>();

  for (const product of products) {
    const raw = product.basic?.productShortName?.trim();
    if (!raw) continue;
    const name = cleanProductName(raw);
    if (!name || looksFlavored(name)) continue;
    const category = vinmonopoletCategory(name);
    if (!category) continue;
    const slug = slugify(name);
    if (!slug || bySlug.has(slug)) continue;

    bySlug.set(slug, {
      name,
      category,
      source: "vinmonopolet",
      ageYears: (() => {
        const m = name.match(/\b(\d{1,2})\s*(?:yo|years?|års?)\b/i);
        const years = m ? Number(m[1]) : NaN;
        return Number.isInteger(years) && years >= 1 && years <= 60 ? years : null;
      })(),
      abv: null,
      avgPrice: null,
      upcs: [],
    });
  }

  return { scanned: products.length, candidates: [...bySlug.values()] };
}

/** Read the API key from the environment; throws with setup guidance when missing. */
export function vinmonopoletApiKey(): string {
  const key = process.env.VINMONOPOLET_API_KEY;
  if (!key) {
    throw new Error(
      "VINMONOPOLET_API_KEY is not set. Sign up for a free key at https://api.vinmonopolet.no/ (products API) and export it before running: pnpm ingest vinmonopolet",
    );
  }
  return key;
}

/** Union the whisky-signal searches, paging each until a short page. */
export async function fetchVinmonopoletCandidates(
  fetchImpl: typeof fetch = fetch,
): Promise<VinmonopoletAdapterResult> {
  const key = vinmonopoletApiKey();
  const seen = new Map<string, VinmonopoletProduct>();
  let scanned = 0;

  for (const term of VINMONOPOLET_SEARCH_TERMS) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        `${VINMONOPOLET_PRODUCTS_URL}?productShortNameContains=${encodeURIComponent(term)}` +
        `&start=${page * PAGE_SIZE}&maxResults=${PAGE_SIZE}`;
      const res = await fetchImpl(url, {
        headers: { "Ocp-Apim-Subscription-Key": key, accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Vinmonopolet download failed: HTTP ${res.status} for term "${term}"`);
      }
      const batch = (await res.json()) as VinmonopoletProduct[];
      if (!Array.isArray(batch)) {
        throw new Error(`Vinmonopolet returned a non-array payload for term "${term}"`);
      }
      scanned += batch.length;
      for (const product of batch) {
        const id = product.basic?.productId;
        if (id && !seen.has(id)) seen.set(id, product);
      }
      if (batch.length < PAGE_SIZE) break;
    }
  }

  const result = vinmonopoletProductsToCandidates([...seen.values()]);
  return { scanned, candidates: result.candidates };
}
