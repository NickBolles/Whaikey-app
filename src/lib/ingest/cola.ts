import type { WhiskeyCategory } from "@/db/schema";
import { cleanProductName, looksFlavored, slugify } from "./normalize";
import type { CatalogCandidate } from "./types";

/**
 * TTB COLA public registry ingest (docs/DATA_SOURCES.md §2.1).
 *
 * Every US label approval since 1999 is public. The registry has no JSON API;
 * the supported bulk path (documented in TTB's "Save Search Results in Public
 * COLA Registry" guide) is: run a public search, then download the session's
 * results as CSV via publicSaveSearchResultsToFile.do. Each search returns at
 * most 500 rows, so the fetcher chunks the requested date range by month and
 * narrows by class/type code until each chunk fits.
 *
 * COLA rows are label approvals, not products: no ABV, no price, no barcode,
 * and one product can have many approvals. Candidates therefore carry name +
 * category only, and dedupe by cleaned name.
 */

const COLA_BASE = "https://www.ttbonline.gov/colasonline";
export const COLA_SEARCH_PAGE_URL = `${COLA_BASE}/publicSearchColasBasic.do`;
export const COLA_SEARCH_PROCESS_URL = `${COLA_BASE}/publicSearchColasBasicProcess.do`;
export const COLA_SAVE_RESULTS_URL = `${COLA_BASE}/publicSaveSearchResultsToFile.do?path=/publicSearchColasBasicProcess`;

/**
 * TTB class/type codes for the whisky family sit in the 100–199 range
 * (e.g. 101 straight bourbon, 141 bourbon, 142 rye, 153 single malt scotch).
 * Flavored "whisky specialties" (600s) are intentionally out of range.
 */
export const WHISKY_CLASS_RANGE = { from: "100", to: "199" } as const;
export const COLA_FULL_HISTORY_START = "1999-01-01";
const COLA_RESULT_LIMIT = 500;

export interface ColaRecord {
  ttbId: string;
  permitNo: string;
  serialNumber: string;
  completedDate: string;
  fancifulName: string;
  brandName: string;
  origin: string;
  classType: string;
}

/**
 * Parse the Save-Search-Results CSV. Columns (per TTB's guide): TTB ID,
 * Permit No., Serial Number, Completed Date, Fanciful Name, Brand Name,
 * Origin, Class/Type. TTB wraps IDs in single quotes to keep Excel from
 * eating leading zeros.
 */
export function parseColaCsv(csv: string): ColaRecord[] {
  return parseColaCsvResult(csv).records;
}

interface ColaCsvResult {
  records: ColaRecord[];
  dataRows: number;
}

/** Parse a COLA export and retain its raw row count for cap safety checks. */
function parseColaCsvResult(csv: string): ColaCsvResult {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { records: [], dataRows: 0 };
  const records: ColaRecord[] = [];
  let dataRows = 0;
  for (const line of lines) {
    const cells = splitCsvLine(line);
    if (cells[0]?.trim() === "TTB ID") continue;
    dataRows += 1;
    if (cells.length < 8) continue;
    const ttbId = cells[0].replace(/^'+|'+$/g, "").trim();
    if (!/^\d{6,}$/.test(ttbId)) continue; // header or malformed row
    records.push({
      ttbId,
      permitNo: cells[1].trim(),
      serialNumber: cells[2].trim(),
      completedDate: cells[3].trim(),
      fancifulName: cells[4].trim(),
      brandName: cells[5].trim(),
      origin: cells[6].trim(),
      classType: cells[7].trim(),
    });
  }
  return { records, dataRows };
}

/** Minimal RFC-4180 line splitter (quoted cells, doubled quotes). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** Class/type codes we can map directly; everything else classifies by text. */
const CLASS_TYPE_MAP: Record<string, WhiskeyCategory> = {
  "101": "bourbon", // straight bourbon whisky
  "141": "bourbon", // bourbon whisky
  "102": "rye", // straight rye whisky
  "142": "rye", // rye whisky
  "153": "scotch-single-malt", // single malt scotch whisky
};

/**
 * Classify a COLA row into our taxonomy, or null when we can't say — unknown
 * rows are skipped rather than guessed into the wrong shelf.
 */
export function classifyColaRecord(rec: ColaRecord): WhiskeyCategory | null {
  const mapped = CLASS_TYPE_MAP[rec.classType];
  if (mapped) return mapped;
  const text = `${rec.brandName} ${rec.fancifulName}`.toLowerCase();
  if (!/whisk(e?y|ies)|bourbon|scotch/.test(text)) return null;
  if (/japanese|suntory|nikka|yamazaki|hakushu|hibiki/.test(text)) return "japanese";
  if (/single malt scotch/.test(text)) return "scotch-single-malt";
  if (/scotch/.test(text)) return "scotch-blended";
  if (/irish/.test(text)) return "irish";
  if (/canadian/.test(text)) return "canadian";
  if (/tennessee/.test(text)) return "american-other";
  // Country-marked malts were caught above; the registry is US label
  // approvals, so a remaining bare "single malt" is overwhelmingly American.
  if (/single malt/.test(text)) return "american-single-malt";
  if (/bourbon/.test(text)) return "bourbon";
  if (/\brye\b/.test(text)) return "rye";
  if (/corn whisk|wheat whisk|white whisk|moonshine|blended american/.test(text)) {
    return "american-other";
  }
  return null;
}

export interface ColaAdapterResult {
  scanned: number;
  candidates: CatalogCandidate[];
}

/** Collapse label-approval rows into deduped catalog candidates. */
export function colaRecordsToCandidates(records: ColaRecord[]): ColaAdapterResult {
  const bySlug = new Map<string, CatalogCandidate>();
  for (const rec of records) {
    const category = classifyColaRecord(rec);
    if (!category) continue;
    // Brand name is the product; the fanciful name (when present) is the
    // expression. "OLD TOWN" + "WINTER RESERVE" → "Old Town Winter Reserve".
    const rawName = rec.fancifulName
      ? `${rec.brandName} ${rec.fancifulName}`
      : rec.brandName;
    const name = cleanProductName(titleCase(rawName));
    if (!name || looksFlavored(name)) continue;
    const slug = slugify(name);
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, { name, category, source: "cola" });
  }
  return { scanned: records.length, candidates: [...bySlug.values()] };
}

/** COLA text is ALL CAPS; bring it to title case with small-word handling. */
export function titleCase(s: string): string {
  const small = new Set(["of", "the", "and", "in", "at", "de", "du", "da"]);
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      if (i > 0 && small.has(w)) return w;
      // Keep pure numerals/roman-ish tokens as-is; capitalize hyphen parts.
      return w
        .split("-")
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
        .join("-");
    })
    .join(" ")
    .replace(/\bMc(\w)/g, (_, c: string) => `Mc${c.toUpperCase()}`)
    .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n: string, suf: string) => `${n}${suf.toLowerCase()}`);
}

export interface ColaFetchOptions {
  /** Inclusive approval-date range, ISO (yyyy-mm-dd). */
  since: string;
  until: string;
  classFrom?: string;
  classTo?: string;
  fetchImpl?: typeof fetch;
  /** Called between requests; override in tests to skip the politeness delay. */
  sleep?: (ms: number) => Promise<void>;
}

const REQUEST_DELAY_MS = 1500;

/**
 * Fetch whisky label approvals for a date range from the public registry.
 * The registry caps each download at 500 rows, so broad month searches are
 * split recursively by date (then by class range for an unusually busy day)
 * until every downloaded result set is below that cap. This makes historical
 * backfills complete rather than silently accepting a truncated export.
 */
export async function fetchColaRecords(opts: ColaFetchOptions): Promise<ColaRecord[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const classFrom = opts.classFrom ?? WHISKY_CLASS_RANGE.from;
  const classTo = opts.classTo ?? WHISKY_CLASS_RANGE.to;

  const all: ColaRecord[] = [];
  for (const [from, to] of monthChunks(opts.since, opts.until)) {
    const records = await fetchCompleteColaRange({
      from,
      to,
      classFrom,
      classTo,
      fetchImpl,
      sleep,
    });
    all.push(...records);
  }
  return all;
}

/** Split [since, until] into calendar-month [from, to] pairs (ISO dates). */
export function monthChunks(since: string, until: string): Array<[string, string]> {
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error(`Invalid COLA date range: ${since}..${until}`);
  }
  const chunks: Array<[string, string]> = [];
  let cur = start;
  while (cur <= end) {
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0));
    const chunkEnd = monthEnd < end ? monthEnd : end;
    chunks.push([toIso(cur), toIso(chunkEnd)]);
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return chunks;
}

const toIso = (d: Date): string => d.toISOString().slice(0, 10);
/** ISO yyyy-mm-dd → the registry's MM/DD/YYYY form values. */
const toRegistryDate = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};

interface ChunkOptions {
  from: string;
  to: string;
  classFrom: string;
  classTo: string;
  fetchImpl: typeof fetch;
}

interface CompleteRangeOptions extends ChunkOptions {
  sleep: (ms: number) => Promise<void>;
}

async function fetchCompleteColaRange(o: CompleteRangeOptions): Promise<ColaRecord[]> {
  const { records, dataRows } = await fetchColaChunk(o);
  await o.sleep(REQUEST_DELAY_MS);
  if (dataRows !== records.length) {
    throw new Error(
      `TTB COLA export for ${o.from}..${o.to} contained ${dataRows} rows but only ` +
        `${records.length} could be parsed; refusing an incomplete import.`,
    );
  }
  if (dataRows < COLA_RESULT_LIMIT) return records;

  const dateRanges = splitDateRange(o.from, o.to);
  if (dateRanges) {
    console.warn(`COLA: splitting capped ${o.from}..${o.to} search by approval date.`);
    const nested: ColaRecord[] = [];
    for (const [from, to] of dateRanges) {
      nested.push(...(await fetchCompleteColaRange({ ...o, from, to })));
    }
    return nested;
  }

  const classRanges = splitClassRange(o.classFrom, o.classTo);
  if (classRanges) {
    console.warn(
      `COLA: splitting capped ${o.from} ${o.classFrom}..${o.classTo} search by class/type.`,
    );
    const nested: ColaRecord[] = [];
    for (const [classFrom, classTo] of classRanges) {
      nested.push(...(await fetchCompleteColaRange({ ...o, classFrom, classTo })));
    }
    return nested;
  }

  throw new Error(
    `TTB COLA returned its ${COLA_RESULT_LIMIT}-row cap for ${o.from} class/type ${o.classFrom}; ` +
      "cannot safely produce a complete download.",
  );
}

/** Divide an inclusive date range in two, or return null for a single day. */
function splitDateRange(from: string, to: string): [[string, string], [string, string]] | null {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (days < 1) return null;
  const midpoint = new Date(start.getTime() + Math.floor(days / 2) * 86_400_000);
  const next = new Date(midpoint.getTime() + 86_400_000);
  return [
    [toIso(start), toIso(midpoint)],
    [toIso(next), toIso(end)],
  ];
}

/** Divide an inclusive numeric class/type range in two, or return null for one code. */
function splitClassRange(from: string, to: string): [[string, string], [string, string]] | null {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start >= end) return null;
  const midpoint = Math.floor((start + end) / 2);
  return [
    [String(start), String(midpoint)],
    [String(midpoint + 1), String(end)],
  ];
}

async function fetchColaChunk(o: ChunkOptions): Promise<ColaCsvResult> {
  // 1. Establish a session (the JSP app tracks searches server-side).
  const landing = await o.fetchImpl(COLA_SEARCH_PAGE_URL, { redirect: "follow" });
  if (!landing.ok) {
    throw new Error(
      `TTB COLA registry unreachable (HTTP ${landing.status}). The registry has ` +
        `scheduled maintenance windows (often Sundays); try again later.`,
    );
  }
  const cookie = extractCookies(landing.headers);

  // 2. Run the search (form fields per the public basic-search form).
  const params = new URLSearchParams({
    action: "search",
    "searchCriteria.dateCompletedFrom": toRegistryDate(o.from),
    "searchCriteria.dateCompletedTo": toRegistryDate(o.to),
    "searchCriteria.classTypeFrom": o.classFrom,
    "searchCriteria.classTypeTo": o.classTo,
  });
  const search = await o.fetchImpl(`${COLA_SEARCH_PROCESS_URL}?${params.toString()}`, {
    headers: cookie ? { cookie } : undefined,
    redirect: "follow",
  });
  if (!search.ok) {
    throw new Error(`TTB COLA search failed (HTTP ${search.status}) for ${o.from}..${o.to}`);
  }

  // 3. Download this session's results as CSV.
  const file = await o.fetchImpl(COLA_SAVE_RESULTS_URL, {
    headers: cookie ? { cookie } : undefined,
    redirect: "follow",
  });
  if (!file.ok) {
    throw new Error(`TTB COLA results download failed (HTTP ${file.status}) for ${o.from}..${o.to}`);
  }
  const body = await file.text();
  if (/<html/i.test(body.slice(0, 500))) {
    throw new Error(
      "TTB COLA returned a page instead of the results CSV — the registry's form " +
        "fields may have changed; see src/lib/ingest/cola.ts.",
    );
  }
  return parseColaCsvResult(body);
}

function extractCookies(headers: Headers): string {
  const raw = headers.get("set-cookie");
  if (!raw) return "";
  // Keep only the name=value pairs of each cookie.
  return raw
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}
