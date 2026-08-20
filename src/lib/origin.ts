import type { WhiskeyCategory } from "@/db/schema";

/**
 * Where a bottle is from, for display.
 *
 * The catalog stores two separate things — `bottles.country` (always known)
 * and `bottles.region` (sub-national, often null) — because counting them as
 * one field is what let "Scotland" sit alongside "Islay" as if they were peers.
 * Screens still want a single line, so they ask for the most specific name we
 * have: the region when there is one, the country otherwise. A blended Scotch
 * reads "Scotland"; Lagavulin reads "Islay".
 */
export function originLabel(
  region?: string | null,
  country?: string | null,
): string | null {
  return region ?? country ?? null;
}

/**
 * The country a category implies, for categories that are geographically
 * defined — bourbon is a distinctive product of the USA by law, Scotch must be
 * distilled in Scotland, and so on. Used as the ingest fallback when a source
 * doesn't state a country. "rye" is made on both sides of the US/Canada border
 * and "world" says nothing, so both stay null rather than guessing.
 */
export function categoryCountry(category: WhiskeyCategory): string | null {
  switch (category) {
    case "bourbon":
    case "american-single-malt":
    case "american-other":
      return "USA";
    case "scotch-single-malt":
    case "scotch-blended":
      return "Scotland";
    case "irish":
      return "Ireland";
    case "japanese":
      return "Japan";
    case "canadian":
      return "Canada";
    case "rye":
    case "world":
      return null;
  }
}
