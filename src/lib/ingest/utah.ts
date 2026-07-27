import { unzipSync } from "fflate";
import type { WhiskeyCategory } from "@/db/schema";
import { cleanProductName, looksFlavored, slugify, unshoutName } from "./normalize";
import type { CatalogCandidate } from "./types";

/**
 * Utah DABS product list ingest (docs/SOURCING_AT_SCALE.md §3.1).
 *
 * Utah publishes its full state inventory as a fiscal-period XLSX whose URL
 * changes each period, linked from the interactive product list page — so the
 * adapter scrapes the page for the current workbook link first. The workbook
 * stores strings inline (no sharedStrings table), which the tiny sheet reader
 * below handles along with the shared-strings layout for safety. Columns:
 * CSC, Description, …, Size, Retail Price, …, Dept Name, Class name. Names
 * are ALL CAPS with embedded sizes; no ABV, no barcodes.
 */

export const UTAH_PRODUCT_LIST_PAGE = "https://abs.utah.gov/shop-products/interactive-product-list/";

/** Utah "Class name" → our taxonomy. WHISKEY - FLAVORED is deliberately absent. */
export const UTAH_CLASS_MAP: Record<string, WhiskeyCategory> = {
  "WHISKEY - BLENDED": "american-other",
  "WHISKEY - BOURBON & TENNESSEE": "bourbon",
  "WHISKEY - BOURBON SINGLE BARREL, BATCH": "bourbon",
  "WHISKEY - CANADIAN": "canadian",
  "WHISKEY - DOMESTIC": "american-other",
  "WHISKEY - IRISH": "irish",
  "WHISKEY - MISC IMPORTED": "world",
  "WHISKEY - RYE": "rye",
  "WHISKEY - SCOTCH BLENDED": "scotch-blended",
  "WHISKEY - SCOTCH SINGLE MALT": "scotch-single-malt",
};

/** Japanese and single-malt bottlings hide in the import/domestic buckets. */
export function refineUtahCategory(name: string, base: WhiskeyCategory): WhiskeyCategory {
  const n = name.toLowerCase();
  if (/\b(suntory|yamazaki|hakushu|hibiki|toki|nikka|yoichi|taketsuru|iwai|akashi|chichibu)\b/.test(n)) {
    return "japanese";
  }
  if (base === "american-other" && /\bsingle malt\b/.test(n)) return "american-single-malt";
  return base;
}

// ---------------------------------------------------------------------------
// Minimal XLSX sheet reader (fflate unzip + regex over the sheet XML)
// ---------------------------------------------------------------------------

const CELL_RE = /<c(?:\s+[^>]*)?>[\s\S]*?<\/c>|<c(?:\s+[^>]*)?\/>/g;
const ROW_RE = /<row(?:\s+[^>]*)?>([\s\S]*?)<\/row>/g;

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

/** All <t> text content in a cell/si fragment, concatenated (rich-text runs). */
function textRuns(fragment: string): string {
  let out = "";
  for (const m of fragment.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

/** Column index from an A1-style cell reference ("C7" → 2); null when absent. */
function columnIndex(cellXml: string): number | null {
  const ref = cellXml.match(/\br="([A-Z]+)\d+"/)?.[1];
  if (!ref) return null;
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read the first worksheet of an XLSX into rows of strings. Supports inline
 * strings (Utah's layout) and shared strings; numbers pass through as their
 * raw text. Deliberately ignores styles/dates — the product list needs none.
 */
export function readXlsxRows(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes);
  const decoder = new TextDecoder();

  const shared: string[] = [];
  const sharedXml = files["xl/sharedStrings.xml"];
  if (sharedXml) {
    for (const m of decoder.decode(sharedXml).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(textRuns(m[1]));
    }
  }

  const sheetName = Object.keys(files).find((f) => /^xl\/worksheets\/sheet1\.xml$/.test(f)) ??
    Object.keys(files).find((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
  if (!sheetName) throw new Error("XLSX contained no worksheet");
  const sheetXml = decoder.decode(files[sheetName]);

  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(ROW_RE)) {
    const cells: string[] = [];
    let fallbackIndex = 0;
    for (const cellMatch of rowMatch[1].matchAll(CELL_RE)) {
      const cellXml = cellMatch[0];
      const index = columnIndex(cellXml) ?? fallbackIndex;
      fallbackIndex = index + 1;
      const type = cellXml.match(/\bt="([^"]+)"/)?.[1];
      let value = "";
      if (type === "inlineStr") {
        value = textRuns(cellXml);
      } else {
        const v = cellXml.match(/<v(?:\s+[^>]*)?>([\s\S]*?)<\/v>/)?.[1] ?? "";
        value = type === "s" ? (shared[Number(v)] ?? "") : decodeXml(v);
      }
      cells[index] = value;
    }
    rows.push(Array.from(cells, (c) => c ?? ""));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface UtahAdapterResult {
  scanned: number;
  candidates: CatalogCandidate[];
}

/** Find the current fiscal-period workbook URL on the product-list page. */
export function findUtahWorkbookUrl(html: string): string | null {
  return html.match(/href="(https?:\/\/[^"]*Product-List[^"]*\.xlsx)"/i)?.[1] ?? null;
}

/** Collapse product-list rows (header row included) into whiskey candidates. */
export function utahRowsToCandidates(rows: string[][]): UtahAdapterResult {
  const headerIndex = rows.findIndex((r) => r.includes("Description") && r.includes("Class name"));
  if (headerIndex < 0) return { scanned: rows.length, candidates: [] };
  const header = rows[headerIndex];
  const col = (name: string): number => header.indexOf(name);
  const iDesc = col("Description");
  const iClass = col("Class name");
  const iSize = col("Size");
  const iPrice = col("Retail Price");

  interface Working {
    candidate: CatalogCandidate;
    has750Price: boolean;
  }
  const bySlug = new Map<string, Working>();
  let scanned = 0;

  for (const row of rows.slice(headerIndex + 1)) {
    scanned += 1;
    const category = UTAH_CLASS_MAP[(row[iClass] ?? "").trim()];
    const rawName = row[iDesc]?.trim();
    if (!category || !rawName) continue;
    // Clean before un-shouting: embedded sizes ("750ml") carry the only
    // lowercase letters in these names and would defeat the all-caps check.
    const cleaned = cleanProductName(rawName);
    const name = cleaned ? unshoutName(cleaned) : null;
    if (!name || looksFlavored(name)) continue;
    const slug = slugify(name);
    if (!slug) continue;

    let entry = bySlug.get(slug);
    if (!entry) {
      entry = {
        candidate: {
          name,
          category: refineUtahCategory(name, category),
          source: "utah",
          ageYears: null,
          abv: null,
          avgPrice: null,
          upcs: [],
        },
        has750Price: false,
      };
      bySlug.set(slug, entry);
    }

    const is750 = (row[iSize] ?? "").trim() === "750";
    const price = Number(row[iPrice]);
    if (Number.isFinite(price) && price > 0 && (is750 || !entry.has750Price)) {
      if (is750 || entry.candidate.avgPrice == null) {
        entry.candidate.avgPrice = price;
        entry.has750Price = entry.has750Price || is750;
      }
    }
  }

  return { scanned, candidates: [...bySlug.values()].map((w) => w.candidate) };
}

/** Discover the current workbook from the product-list page, download, parse. */
export async function fetchUtahCandidates(
  fetchImpl: typeof fetch = fetch,
): Promise<UtahAdapterResult> {
  const pageRes = await fetchImpl(UTAH_PRODUCT_LIST_PAGE);
  if (!pageRes.ok) {
    throw new Error(`Utah product-list page failed: HTTP ${pageRes.status} from ${UTAH_PRODUCT_LIST_PAGE}`);
  }
  const url = findUtahWorkbookUrl(await pageRes.text());
  if (!url) throw new Error("Utah product-list page had no Product-List .xlsx link");
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Utah workbook download failed: HTTP ${res.status} from ${url}`);
  return utahRowsToCandidates(readXlsxRows(new Uint8Array(await res.arrayBuffer())));
}
