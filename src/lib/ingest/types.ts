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
  source: "iowa" | "cola" | "oregon" | "utah" | "bc" | "systembolaget" | "whiskyedition" | "vinmonopolet";
  region?: string;
  ageYears?: number | null;
  abv?: number | null;
  /** Typical 750ml retail price when the source provides one. */
  avgPrice?: number | null;
  /** Normalized, check-digit-valid GTINs. */
  upcs?: string[];
  /**
   * Present when this candidate comes from a real retail listing (state price
   * list, monopoly assortment, published review) — evidence the product
   * actually shipped, used to promote imported bottles to "verified" without
   * a model call (docs/DATA_SOURCES.md §2.4b triage). TTB COLA candidates
   * never carry this: a label approval is not proof of sale.
   */
  retailEvidence?: { url: string; label: string };
}

export interface IngestReport {
  source: string;
  /** Source rows seen before any filtering. */
  scanned: number;
  /** Candidates produced after filtering/dedupe. */
  candidates: number;
  /** Candidates that matched an existing bottle (by id, name, alias, or variant match key). */
  matchedExisting: number;
  /** New bottles inserted (status "imported"). */
  inserted: number;
  /** New UPC mappings attached (to both new and existing bottles). */
  upcsAdded: number;
  /** Variant spellings recorded into bottle_aliases for matched bottles. */
  aliasesAdded: number;
  /** Null attributes (abv/ageYears/avgPrice/region) filled on matched bottles. */
  fieldsFilled: number;
  /** Imported bottles promoted to "verified" on retail-listing evidence (no model call). */
  verifiedByRetail: number;
  /** Human-readable disagreements between a candidate and stored values (nothing was overwritten). */
  conflicts: string[];
  /** True when the run made no writes. */
  dryRun: boolean;
}
