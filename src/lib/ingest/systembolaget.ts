import type { WhiskeyCategory } from "@/db/schema";
import { cleanProductName, looksFlavored, parseAgeText, slugify } from "./normalize";
import type { CatalogCandidate } from "./types";

/**
 * Systembolaget (Sweden) catalog ingest via the community data mirror
 * (docs/SOURCING_AT_SCALE.md §3.1).
 *
 * Systembolaget removed its official API, but the C4illin/systembolaget-data
 * mirror republishes the full assortment daily as one JSON array. ~2k whisky
 * rows with producer, ABV, country, and structured "taste clock" numbers.
 * European/Scotch coverage the US feeds lack. Prices are SEK and NOT
 * imported; no barcodes. Per the source's closed-API history this is an
 * enrichment source only — never build a hard dependency on it
 * (docs/DATA_SOURCES.md single-source risk rule).
 */

export const SYSTEMBOLAGET_MIRROR_URL = "https://susbolaget.emrik.org/v1/products";

/** The subset of mirror fields the adapter reads. */
export interface SystembolagetProduct {
  productNameBold?: string | null;
  productNameThin?: string | null;
  producerName?: string | null;
  categoryLevel2?: string | null;
  /** "Maltwhisky", "Bourbon", "Ryewhisky", "Blended whisky", … */
  categoryLevel3?: string | null;
  /** Swedish country name ("Storbritannien", "USA", "Japan", …). */
  country?: string | null;
  alcoholPercentage?: number | null;
  isDiscontinued?: boolean | null;
}

const SCOTLAND = /^(Storbritannien|Skottland)$/i;

/** Map a whisky row's level-3 category + origin country to our taxonomy. */
export function systembolagetCategory(p: SystembolagetProduct): WhiskeyCategory | null {
  const level3 = (p.categoryLevel3 ?? "").trim();
  const country = (p.country ?? "").trim();
  switch (level3) {
    case "Bourbon":
      return "bourbon";
    case "Ryewhisky":
      return "rye";
    case "Tennessee whiskey":
    case "Cornwhisky":
    case "Wheatwhisky":
      return "american-other";
    case "Maltwhisky":
      if (SCOTLAND.test(country)) return "scotch-single-malt";
      if (country === "USA") return "american-single-malt";
      if (country === "Japan") return "japanese";
      if (country === "Irland") return "irish";
      return "world";
    case "Blended whisky":
    case "Grainwhisky":
      if (SCOTLAND.test(country)) return "scotch-blended";
      if (country === "Japan") return "japanese";
      if (country === "Irland") return "irish";
      if (country === "Kanada") return "canadian";
      if (country === "USA") return "american-other";
      return "world";
    case "Annan whisky":
      if (country === "Irland") return "irish";
      if (country === "Kanada") return "canadian";
      if (country === "Japan") return "japanese";
      return "world";
    default:
      return null; // "Maltsprit" (unaged) and anything unrecognized
  }
}

/**
 * Swedish country names → the catalog's English names. "Storbritannien"
 * (Great Britain) is deliberately absent: it doesn't say which whisky nation,
 * and the category fallback already resolves the Scotch rows to Scotland.
 * Unknown values return null rather than leaking Swedish into the catalog.
 */
const SWEDISH_COUNTRIES: Record<string, string> = {
  Skottland: "Scotland",
  England: "England",
  Wales: "Wales",
  Irland: "Ireland",
  USA: "USA",
  Kanada: "Canada",
  Japan: "Japan",
  Taiwan: "Taiwan",
  Indien: "India",
  Sverige: "Sweden",
  Norge: "Norway",
  Danmark: "Denmark",
  Finland: "Finland",
  Island: "Iceland",
  Tyskland: "Germany",
  Frankrike: "France",
  Nederländerna: "Netherlands",
  Belgien: "Belgium",
  Schweiz: "Switzerland",
  Österrike: "Austria",
  Italien: "Italy",
  Spanien: "Spain",
  Tjeckien: "Czechia",
  Australien: "Australia",
  "Nya Zeeland": "New Zealand",
  Sydafrika: "South Africa",
  Israel: "Israel",
};

export function systembolagetCountry(p: SystembolagetProduct): string | null {
  return SWEDISH_COUNTRIES[(p.country ?? "").trim()] ?? null;
}

export interface SystembolagetAdapterResult {
  scanned: number;
  candidates: CatalogCandidate[];
}

/** Collapse mirror products into deduped whisky candidates (no prices — SEK). */
export function systembolagetProductsToCandidates(
  products: SystembolagetProduct[],
): SystembolagetAdapterResult {
  const bySlug = new Map<string, CatalogCandidate>();
  let scanned = 0;

  for (const p of products) {
    if ((p.categoryLevel2 ?? "") !== "Whisky") continue;
    scanned += 1;
    if (p.isDiscontinued) continue;
    const category = systembolagetCategory(p);
    if (!category) continue;

    // Names are split bold/thin ("Thy" + "BOG Single Malt Whisky"); rejoin.
    const rawName = [p.productNameBold, p.productNameThin]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(" ");
    const name = cleanProductName(rawName);
    if (!name || looksFlavored(name)) continue;
    const slug = slugify(name);
    if (!slug || bySlug.has(slug)) continue;

    const abv = p.alcoholPercentage;
    bySlug.set(slug, {
      name,
      category,
      source: "systembolaget",
      country: systembolagetCountry(p) ?? undefined,
      ageYears: parseAgeText(name.match(/\b(\d{1,2})\s*(?:år|year)/i)?.[1] ?? null),
      abv: typeof abv === "number" && abv >= 20 && abv <= 80 ? abv : null,
      avgPrice: null,
      upcs: [],
    });
  }

  return { scanned, candidates: [...bySlug.values()] };
}

/** Download and parse the daily mirror snapshot (~100 MB JSON). */
export async function fetchSystembolagetCandidates(
  fetchImpl: typeof fetch = fetch,
): Promise<SystembolagetAdapterResult> {
  const res = await fetchImpl(SYSTEMBOLAGET_MIRROR_URL);
  if (!res.ok) {
    throw new Error(
      `Systembolaget mirror download failed: HTTP ${res.status} from ${SYSTEMBOLAGET_MIRROR_URL}`,
    );
  }
  const products = (await res.json()) as SystembolagetProduct[];
  if (!Array.isArray(products)) throw new Error("Systembolaget mirror returned a non-array payload");
  return systembolagetProductsToCandidates(products);
}
