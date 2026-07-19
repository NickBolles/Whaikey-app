import type { WhiskeyCategory } from "@/db/schema";

/**
 * A normalized catalog row produced by a source adapter (Iowa, TTB COLA, …)
 * before it is matched against — and possibly inserted into — the bottles
 * table. Adapters do all source-specific parsing; the shared ingest core only
 * sees this shape.
 */
export interface CatalogCandidate {
  /** Cleaned display name, e.g. "Wayne Gretzky No. 99 Red Cask". */
  name: string;
  category: WhiskeyCategory;
  /** Data source tag, recorded in the ingest report and UPC rows. */
  source: "iowa" | "cola";
  region?: string;
  ageYears?: number | null;
  abv?: number | null;
  /** Typical 750ml retail price when the source provides one. */
  avgPrice?: number | null;
  /** Normalized, check-digit-valid GTINs. */
  upcs?: string[];
}

export interface IngestReport {
  source: string;
  /** Source rows seen before any filtering. */
  scanned: number;
  /** Candidates produced after filtering/dedupe. */
  candidates: number;
  /** Candidates that matched an existing bottle (by id, name, or alias). */
  matchedExisting: number;
  /** New bottles inserted (status "imported"). */
  inserted: number;
  /** New UPC mappings attached (to both new and existing bottles). */
  upcsAdded: number;
  /** True when the run made no writes. */
  dryRun: boolean;
}
