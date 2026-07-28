import type { WhiskeyCategory } from "@/db/schema";
import { parseCsvRecords } from "./csv";
import { cleanProductName, looksFlavored, parseAgeText, proofToAbv, slugify, unshoutName } from "./normalize";
import type { CatalogCandidate } from "./types";

/**
 * Oregon OLCC monthly pricing ingest (docs/SOURCING_AT_SCALE.md §3.1).
 *
 * Oregon publishes every spirit sold in the state on the official open-data
 * portal (Socrata CSV export): item code, description, category, size, age
 * ("3 YRS"), proof, and monthly shelf price. The export contains many monthly
 * snapshots, so rows are filtered to the most recent AsOfDate; the same item
 * appears once per size, collapsed to one candidate preferring the 750 ML
 * price. Names are ALL CAPS in the feed. No barcodes.
 */

export const OREGON_PRICING_URL =
  "https://data.oregon.gov/api/v3/views/vmf2-f83h/export.csv?accessType=DOWNLOAD";

/** Oregon category → our taxonomy; DOMESTIC WHISKEY et al. get refined from the name. */
export const OREGON_CATEGORY_MAP: Record<string, WhiskeyCategory> = {
  "DOMESTIC WHISKEY": "american-other",
  SCOTCH: "scotch-blended",
  CANADIAN: "canadian",
  IRISH: "irish",
  "OTHER IMPORTED WHISKY": "world",
  WHISKEY: "american-other",
};

/** Refine a coarse Oregon shelf bucket from name cues (same idea as refineIowaCategory). */
export function refineOregonCategory(name: string, base: WhiskeyCategory): WhiskeyCategory {
  const n = name.toLowerCase();
  if (/\b(japanese|suntory|yamazaki|hakushu|hibiki|toki|nikka|yoichi|iwai|akashi|chichibu)\b/.test(n)) {
    return "japanese";
  }
  if (base === "scotch-blended" && /\bsingle malt\b/.test(n) && !/\bblend/.test(n)) {
    return "scotch-single-malt";
  }
  if (base === "american-other") {
    if (/\bbourbon\b/.test(n)) return "bourbon";
    if (/\brye\b/.test(n)) return "rye";
    if (/\bsingle malt\b/.test(n)) return "american-single-malt";
  }
  return base;
}

/** The subset of export columns the adapter reads. */
export interface OregonRow {
  AsOfDate?: string;
  Description?: string;
  Category?: string;
  Size?: string;
  Age?: string;
  Proof?: string;
  PricePerBottle?: string;
}

export interface OregonAdapterResult {
  scanned: number;
  candidates: CatalogCandidate[];
}

/** "$32.95" → 32.95; null for missing/zero. */
function parsePrice(raw: string | undefined): number | null {
  const n = Number((raw ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Latest AsOfDate (MM/DD/YYYY) in the export, or null when none parse. */
export function latestAsOfDate(rows: OregonRow[]): string | null {
  let best: string | null = null;
  let bestKey = "";
  for (const row of rows) {
    const d = row.AsOfDate;
    const m = d?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) continue;
    const key = `${m[3]}${m[1]}${m[2]}`;
    if (key > bestKey) {
      bestKey = key;
      best = d!;
    }
  }
  return best;
}

/** Collapse the latest month's Oregon rows into deduped whiskey candidates. */
export function oregonRowsToCandidates(rows: OregonRow[]): OregonAdapterResult {
  const latest = latestAsOfDate(rows);
  interface Working {
    candidate: CatalogCandidate;
    has750Price: boolean;
  }
  const bySlug = new Map<string, Working>();

  for (const row of rows) {
    if (!latest || row.AsOfDate !== latest) continue;
    const category = OREGON_CATEGORY_MAP[row.Category ?? ""];
    if (!category || !row.Description) continue;
    const cleaned = cleanProductName(row.Description);
    const name = cleaned ? unshoutName(cleaned) : null;
    if (!name || looksFlavored(name)) continue;
    const slug = slugify(name);
    if (!slug) continue;

    let entry = bySlug.get(slug);
    if (!entry) {
      entry = {
        candidate: {
          name,
          category: refineOregonCategory(name, category),
          source: "oregon",
          ageYears: parseAgeText(row.Age),
          abv: proofToAbv(row.Proof),
          avgPrice: null,
          upcs: [],
          retailEvidence: { url: OREGON_PRICING_URL, label: "Oregon OLCC monthly pricing" },
        },
        has750Price: false,
      };
      bySlug.set(slug, entry);
    }

    const is750 = row.Size?.trim() === "750 ML";
    const price = parsePrice(row.PricePerBottle);
    if (price != null && (is750 || !entry.has750Price)) {
      if (is750 || entry.candidate.avgPrice == null) {
        entry.candidate.avgPrice = price;
        entry.has750Price = entry.has750Price || is750;
      }
    }
  }

  return { scanned: rows.length, candidates: [...bySlug.values()].map((w) => w.candidate) };
}

/** Download and parse the live Oregon pricing export. */
export async function fetchOregonCandidates(
  fetchImpl: typeof fetch = fetch,
): Promise<OregonAdapterResult> {
  const res = await fetchImpl(OREGON_PRICING_URL);
  if (!res.ok) {
    throw new Error(`Oregon pricing download failed: HTTP ${res.status} from ${OREGON_PRICING_URL}`);
  }
  const records = parseCsvRecords(await res.text()) as OregonRow[];
  return oregonRowsToCandidates(records);
}
