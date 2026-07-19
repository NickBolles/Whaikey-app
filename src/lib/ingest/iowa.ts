import { unzipSync } from "fflate";
import type { WhiskeyCategory } from "@/db/schema";
import { isValidUpc, normalizeUpc } from "@/lib/upc";
import { cleanProductName, looksFlavored, parseAgeYears, proofToAbv, slugify } from "./normalize";
import type { CatalogCandidate } from "./types";

/**
 * Iowa Liquor Products ingest (docs/DATA_SOURCES.md §2.2).
 *
 * The State of Iowa publishes its full wholesale product catalog (CC-BY 4.0)
 * on the Iowa Data Hub. The rows endpoint returns a ZIP containing one
 * newline-delimited JSON file; each row is a purchasable SKU with product
 * name, category, vendor, proof, size, UPC, and state retail price.
 * The same item can appear multiple times (per size, and duplicated under
 * "Temporary & Specialty Packages"), so rows collapse to one candidate per
 * cleaned product name, preferring the 750ml listing for price.
 */

export const IOWA_PRODUCTS_URL = "https://idh-be.iowa.gov/api/v1/datasets/1029/rows.json";

/** The subset of row fields the adapter reads (feed has more). */
export interface IowaProductRow {
  item_no?: string;
  category_name?: string;
  im_desc?: string;
  vendor_name?: string;
  bottle_volume_ml?: number;
  age?: string | number;
  proof?: number | string;
  upc?: string;
  state_bottle_retail?: number;
}

/**
 * Iowa category → our taxonomy. Categories not listed (vodka, liqueurs — and
 * deliberately "Whiskey Liqueur") are ignored. "Temporary & Specialty
 * Packages" is excluded because those rows duplicate an item's real listing.
 */
export const IOWA_CATEGORY_MAP: Record<string, WhiskeyCategory> = {
  "Straight Bourbon Whiskies": "bourbon",
  "Single Barrel Bourbon Whiskies": "bourbon",
  "Bottled in Bond Bourbon": "bourbon",
  "Straight Rye Whiskies": "rye",
  "Single Malt Scotch": "scotch-single-malt",
  "Scotch Whiskies": "scotch-blended",
  "Canadian Whiskies": "canadian",
  "Irish Whiskies": "irish",
  "Tennessee Whiskies": "american-other",
  "Corn Whiskies": "american-other",
  "Blended Whiskies": "american-other",
  "American Single Malt Whiskies": "american-single-malt",
};

const JAPANESE_MARKERS =
  /\b(japanese whisky|suntory|yamazaki|hakushu|hibiki|toki|nikka|yoichi|miyagikyo|taketsuru|iwai|komagatake|akashi|chichibu|mars whisky|hatozaki|kaiyo|togouchi|kujira)\b/i;

/**
 * Iowa's categories are shelving buckets, not a taxonomy — Japanese malts sit
 * under "Scotch Whiskies", Balcones single malt under "Corn Whiskies", world
 * blends under "Blended Whiskies". Refine the mapped category from the name.
 */
export function refineIowaCategory(name: string, base: WhiskeyCategory): WhiskeyCategory {
  const n = name.toLowerCase();
  if (JAPANESE_MARKERS.test(name)) return "japanese";
  if (base === "scotch-blended" && /\bsingle malt\b/.test(n) && !/\bblend/.test(n)) {
    return "scotch-single-malt";
  }
  if (base === "american-other") {
    if (/\birish\b/.test(n)) return "irish";
    if (/\bcanadian\b/.test(n)) return "canadian";
    if (/\bscotch\b/.test(n)) return "scotch-blended";
    if (/\bbourbon\b/.test(n)) return "bourbon";
    if (/\brye\b/.test(n) && !/\bbourbon\b/.test(n)) return "rye";
    if (/\bsingle malt\b/.test(n)) return "american-single-malt";
  }
  return base;
}

/**
 * Rows that are not general-catalog products: retailer barrel picks ("BP …")
 * are one-off single barrels, and "HA …" (holiday-allocation) rows duplicate
 * products under a program prefix — strip the prefix so they match the real
 * product instead of creating a near-duplicate.
 */
function programAdjustedName(raw: string): string | null {
  if (/^BP\s/.test(raw)) return null; // store barrel picks: skip entirely
  return raw.replace(/^HA\s+/, "");
}

/** Unzip the Iowa download and return the NDJSON text it contains. */
export function unzipIowaPayload(zipBytes: Uint8Array): string {
  const entries = unzipSync(zipBytes);
  const names = Object.keys(entries);
  if (names.length === 0) throw new Error("Iowa download contained no files");
  return new TextDecoder().decode(entries[names[0]]);
}

export function parseIowaRows(ndjson: string): IowaProductRow[] {
  const rows: IowaProductRow[] = [];
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as IowaProductRow);
    } catch {
      // Tolerate the occasional malformed line rather than failing the sync.
    }
  }
  return rows;
}

export interface IowaAdapterResult {
  scanned: number;
  candidates: CatalogCandidate[];
}

/** Collapse raw Iowa rows into deduped whiskey catalog candidates. */
export function iowaRowsToCandidates(rows: IowaProductRow[]): IowaAdapterResult {
  interface Working {
    candidate: CatalogCandidate;
    /** Whether the price came from a 750ml row (preferred). */
    has750Price: boolean;
    upcs: Set<string>;
  }
  const bySlug = new Map<string, Working>();

  for (const row of rows) {
    const category = IOWA_CATEGORY_MAP[row.category_name ?? ""];
    if (!category || !row.im_desc) continue;
    const adjusted = programAdjustedName(row.im_desc);
    if (!adjusted) continue;
    const name = cleanProductName(adjusted);
    if (!name || looksFlavored(name)) continue;

    const slug = slugify(name);
    if (!slug) continue;

    let entry = bySlug.get(slug);
    if (!entry) {
      entry = {
        candidate: {
          name,
          category: refineIowaCategory(name, category),
          source: "iowa",
          ageYears: parseAgeYears(row.age),
          abv: proofToAbv(row.proof),
          avgPrice: null,
          upcs: [],
        },
        has750Price: false,
        upcs: new Set(),
      };
      bySlug.set(slug, entry);
    }

    const is750 = row.bottle_volume_ml === 750;
    const retail = row.state_bottle_retail;
    if (typeof retail === "number" && retail > 0 && (is750 || entry.candidate.avgPrice == null)) {
      if (is750 || !entry.has750Price) {
        entry.candidate.avgPrice = retail;
        entry.has750Price = entry.has750Price || is750;
      }
    }
    // Only keep barcodes from the standard bottle: other sizes have their own
    // GTINs, which would mislead scan resolution toward the wrong product.
    if (is750 && row.upc) {
      const upc = normalizeUpc(row.upc);
      if (upc && isValidUpc(upc)) entry.upcs.add(upc);
    }
  }

  const candidates = [...bySlug.values()].map((w) => ({
    ...w.candidate,
    upcs: [...w.upcs],
  }));
  return { scanned: rows.length, candidates };
}

/**
 * Download and parse the live Iowa products feed. `fetchImpl` is injectable
 * for tests; network failures throw with a message pointing at the source.
 */
export async function fetchIowaCandidates(
  fetchImpl: typeof fetch = fetch,
): Promise<IowaAdapterResult> {
  const res = await fetchImpl(IOWA_PRODUCTS_URL);
  if (!res.ok) {
    throw new Error(`Iowa products download failed: HTTP ${res.status} from ${IOWA_PRODUCTS_URL}`);
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());
  return iowaRowsToCandidates(parseIowaRows(unzipIowaPayload(zipBytes)));
}
