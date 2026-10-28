import { sql, type SQL } from "drizzle-orm";
import catalogSources from "../../config/catalog-sources.json";
import type { SourceEntry } from "./bottle-art";

/**
 * When a bottle has display-licensed shots from several sources, the best
 * one wins: lower `photoPriority` first (set per source in
 * config/catalog-sources.json from the photo audit — packshot quality,
 * resolution, clean background), then the source id as a stable tie-break.
 * Sources without a priority sort after every source with one.
 */
export function photoPriorityOrder(
  sourceIdColumn: SQL | { getSQL(): SQL },
  sources: SourceEntry[] = (catalogSources as { sources: SourceEntry[] }).sources,
): SQL {
  const ranked = sources.filter((s) => s.id && typeof s.photoPriority === "number");
  // A cast, not a bare literal: `ORDER BY 0` would be read as a column position.
  if (ranked.length === 0) return sql`0::int`;
  const whens = sql.join(ranked.map((s) => sql`when ${s.id} then ${s.photoPriority}`), sql` `);
  return sql`(case ${sourceIdColumn} ${whens} else 1000000 end)::int`;
}

