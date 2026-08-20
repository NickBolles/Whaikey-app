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
