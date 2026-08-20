import type { WhiskeyCategory } from "@/db/schema";
import { cleanProductName, looksFlavored, slugify } from "./normalize";
import type { CatalogCandidate } from "./types";

/**
 * WHISKY:EDITION review-catalog ingest (docs/SOURCING_AT_SCALE.md §3.2).
 *
 * thewhiskyedition.com publishes its whisky reviews as a free JSON API
 * (OpenAPI at /openapi.json) under CC BY 4.0 — attribution to WHISKY:EDITION
 * is required wherever this data surfaces. Each review carries structured
 * metadata (country, region, age, ABV, distillery, type), which makes it a
 * small but high-quality catalog source for European releases and independent
 * bottlings. Only the factual metadata is imported — review prose and ratings
 * stay out of the catalog (product guardrails + copyright).
 */

export const WHISKY_EDITION_API_URL = "https://thewhiskyedition.com/api/whisky-reviews";

/** The subset of review fields the adapter reads. */
export interface WhiskyEditionReview {
  name?: string;
  metadata?: {
    country?: string | null;
    region?: string | null;
    age?: number | null;
    abv?: number | null;
    distillery?: string | null;
    /** "Single Malt", "Blended Malt", "Bourbon", … */
    type?: string | null;
  };
}

interface WhiskyEditionPage {
  ok?: boolean;
  page?: number;
  per_page?: number;
  total?: number;
  items?: WhiskyEditionReview[];
}

/** Map a review's type + country to our taxonomy. */
export function whiskyEditionCategory(review: WhiskyEditionReview): WhiskeyCategory | null {
  const type = (review.metadata?.type ?? "").toLowerCase();
  const country = (review.metadata?.country ?? "").toLowerCase();
  if (!type && !country) return null;

  if (/bourbon/.test(type)) return "bourbon";
  if (/rye/.test(type)) return "rye";

  const singleMalt = /single malt/.test(type);
  if (country === "scotland") return singleMalt ? "scotch-single-malt" : "scotch-blended";
  if (country === "ireland") return "irish";
  if (country === "japan") return "japanese";
  if (country === "canada") return "canadian";
  if (country === "usa" || country === "united states") {
    return singleMalt ? "american-single-malt" : "american-other";
  }
  return "world";
}

/** Canonical spellings for the country variants the review metadata uses. */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "USA",
  "united states": "USA",
  "united states of america": "USA",
  "u.s.a.": "USA",
};

/**
 * Normalize a review's country to the catalog's English names. The source
 * already writes English ("Scotland", "Japan"), so values pass through as-is;
 * only the US spelling variants need collapsing.
 */
export function whiskyEditionCountry(review: WhiskyEditionReview): string | null {
  const raw = review.metadata?.country?.trim();
  if (!raw) return null;
  return COUNTRY_ALIASES[raw.toLowerCase()] ?? raw;
}

export interface WhiskyEditionAdapterResult {
  scanned: number;
  candidates: CatalogCandidate[];
}

/** Collapse fetched reviews into deduped catalog candidates. */
export function whiskyEditionReviewsToCandidates(
  reviews: WhiskyEditionReview[],
): WhiskyEditionAdapterResult {
  const bySlug = new Map<string, CatalogCandidate>();

  for (const review of reviews) {
    if (!review.name) continue;
    const category = whiskyEditionCategory(review);
    if (!category) continue;
    const name = cleanProductName(review.name);
    if (!name || looksFlavored(name)) continue;
    const slug = slugify(name);
    if (!slug || bySlug.has(slug)) continue;

    const abv = review.metadata?.abv;
    const age = review.metadata?.age;
    bySlug.set(slug, {
      name,
      category,
      source: "whiskyedition",
      country: whiskyEditionCountry(review) ?? undefined,
      region: review.metadata?.region ?? undefined,
      ageYears: typeof age === "number" && age >= 1 && age <= 60 ? Math.round(age) : null,
      abv: typeof abv === "number" && abv >= 20 && abv <= 80 ? abv : null,
      avgPrice: null,
      upcs: [],
    });
  }

  return { scanned: reviews.length, candidates: [...bySlug.values()] };
}

const MAX_PAGES = 100; // safety backstop; the catalog is ~500 reviews today

/** Page through the review API and collapse everything into candidates. */
export async function fetchWhiskyEditionCandidates(
  fetchImpl: typeof fetch = fetch,
): Promise<WhiskyEditionAdapterResult> {
  const reviews: WhiskyEditionReview[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${WHISKY_EDITION_API_URL}?page=${page}`;
    const res = await fetchImpl(url);
    if (!res.ok) {
      throw new Error(`WHISKY:EDITION download failed: HTTP ${res.status} from ${url}`);
    }
    const data = (await res.json()) as WhiskyEditionPage;
    const items = data.items ?? [];
    reviews.push(...items);
    const perPage = data.per_page ?? items.length;
    const total = data.total ?? reviews.length;
    if (items.length === 0 || reviews.length >= total || items.length < perPage) break;
  }
  return whiskyEditionReviewsToCandidates(reviews);
}
