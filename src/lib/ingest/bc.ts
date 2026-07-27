import type { WhiskeyCategory } from "@/db/schema";
import { isValidUpc, normalizeUpc } from "@/lib/upc";
import { parseCsvRecords } from "./csv";
import { cleanProductName, looksFlavored, parseAgeText, slugify, unshoutName } from "./normalize";
import type { CatalogCandidate } from "./types";

/**
 * BC Liquor Distribution Branch product price list ingest
 * (docs/SOURCING_AT_SCALE.md §3.1; Open Government Licence — BC).
 *
 * The dataset is one CSV per month with a month-stamped resource URL, so the
 * adapter resolves the newest resource through the BC Data Catalogue's CKAN
 * API first. Rows carry real product barcodes (PRODUCT_BASE_UPC_NO) and ABV —
 * the fields our scanner grows on. Prices are CAD and deliberately NOT
 * imported (avgPrice is a USD field); BC contributes names, categories, ABV,
 * and barcodes only.
 */

export const BC_CKAN_PACKAGE_URL =
  "https://catalogue.data.gov.bc.ca/api/3/action/package_show?id=bc-liquor-store-product-price-list-historical-prices";

/** BC ITEM_CLASS_NAME → our taxonomy ("Whisky" subcategory only; liqueurs/flavoured skipped). */
export const BC_CLASS_MAP: Record<string, WhiskeyCategory> = {
  "American Whiskey": "american-other",
  "Blended Malt Scotch Whisky": "scotch-blended",
  "Blended Scotch Whisky": "scotch-blended",
  "Bourbon Whiskey": "bourbon",
  "Canadian Whisky": "canadian",
  "Irish Whiskey": "irish",
  "Other Country Whisky": "world",
  "Single Malt Scotch Whisky": "scotch-single-malt",
};

/** Japanese producers routinely land in "Other Country Whisky"; refine from the name. */
export function refineBcCategory(name: string, base: WhiskeyCategory): WhiskeyCategory {
  const n = name.toLowerCase();
  if (/\b(suntory|yamazaki|hakushu|hibiki|toki|nikka|yoichi|taketsuru|iwai|akashi|chichibu|hatozaki|kaiyo)\b/.test(n)) {
    return "japanese";
  }
  if (base === "american-other") {
    if (/\bbourbon\b/.test(n)) return "bourbon";
    if (/\brye\b/.test(n)) return "rye";
    if (/\bsingle malt\b/.test(n)) return "american-single-malt";
  }
  return base;
}

/** The subset of price-list columns the adapter reads. */
export interface BcRow {
  ITEM_CATEGORY_NAME?: string;
  ITEM_SUBCATEGORY_NAME?: string;
  ITEM_CLASS_NAME?: string;
  PRODUCT_LONG_NAME?: string;
  PRODUCT_BASE_UPC_NO?: string;
  PRODUCT_LITRES_PER_CONTAINER?: string;
  PRODUCT_ALCOHOL_PERCENT?: string;
}

export interface BcAdapterResult {
  scanned: number;
  candidates: CatalogCandidate[];
}

/** Collapse BC price-list rows into deduped whiskey candidates (no prices — CAD). */
export function bcRowsToCandidates(rows: BcRow[]): BcAdapterResult {
  interface Working {
    candidate: CatalogCandidate;
    upcs: Set<string>;
  }
  const bySlug = new Map<string, Working>();

  for (const row of rows) {
    if (row.ITEM_SUBCATEGORY_NAME !== "Whisky") continue;
    const category = BC_CLASS_MAP[row.ITEM_CLASS_NAME ?? ""];
    if (!category || !row.PRODUCT_LONG_NAME) continue;
    const cleaned = cleanProductName(row.PRODUCT_LONG_NAME);
    const name = cleaned ? unshoutName(cleaned) : null;
    if (!name || looksFlavored(name)) continue;
    const slug = slugify(name);
    if (!slug) continue;

    let entry = bySlug.get(slug);
    if (!entry) {
      const abvRaw = Number(row.PRODUCT_ALCOHOL_PERCENT);
      entry = {
        candidate: {
          name,
          category: refineBcCategory(name, category),
          source: "bc",
          ageYears: parseAgeText(name.match(/\b(\d{1,2})\s*year/i)?.[1] ?? null),
          abv: Number.isFinite(abvRaw) && abvRaw >= 20 && abvRaw <= 80 ? abvRaw : null,
          avgPrice: null,
          upcs: [],
        },
        upcs: new Set(),
      };
      bySlug.set(slug, entry);
    }

    // Standard-bottle barcodes only, same rule as Iowa: other container sizes
    // carry their own GTINs and would mislead scan resolution.
    if (row.PRODUCT_LITRES_PER_CONTAINER?.trim() === "0.75" && row.PRODUCT_BASE_UPC_NO) {
      const upc = normalizeUpc(row.PRODUCT_BASE_UPC_NO);
      if (upc && isValidUpc(upc)) entry.upcs.add(upc);
    }
  }

  const candidates = [...bySlug.values()].map((w) => ({ ...w.candidate, upcs: [...w.upcs] }));
  return { scanned: rows.length, candidates };
}

interface CkanResource {
  url?: string;
  format?: string;
  created?: string;
  last_modified?: string;
}

/** Pick the newest CSV resource from the CKAN package metadata. */
export function newestBcResourceUrl(pkg: unknown): string | null {
  const resources = (pkg as { result?: { resources?: CkanResource[] } })?.result?.resources;
  if (!Array.isArray(resources)) return null;
  const csvs = resources.filter((r) => r.url && (r.format ?? "").toLowerCase() === "csv");
  csvs.sort((a, b) =>
    (b.last_modified ?? b.created ?? "").localeCompare(a.last_modified ?? a.created ?? ""),
  );
  return csvs[0]?.url ?? null;
}

/** Resolve the newest monthly CSV via CKAN, download, and parse it. */
export async function fetchBcCandidates(
  fetchImpl: typeof fetch = fetch,
): Promise<BcAdapterResult> {
  const metaRes = await fetchImpl(BC_CKAN_PACKAGE_URL);
  if (!metaRes.ok) {
    throw new Error(`BC catalogue lookup failed: HTTP ${metaRes.status} from ${BC_CKAN_PACKAGE_URL}`);
  }
  const url = newestBcResourceUrl(await metaRes.json());
  if (!url) throw new Error("BC catalogue package contained no CSV resources");
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`BC price list download failed: HTTP ${res.status} from ${url}`);
  return bcRowsToCandidates(parseCsvRecords(await res.text()) as BcRow[]);
}
