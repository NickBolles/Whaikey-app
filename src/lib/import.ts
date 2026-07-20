import { BOTTLE_STATUSES, RELATIONSHIPS, type BottleStatus, type Relationship } from "@/db/schema";

/**
 * Spreadsheet/CSV import: pure parsing, column-mapping heuristics, and row
 * normalization. Client-safe (no DB imports). The AI mapping lives in
 * /api/import/analyze and falls back to heuristicMapping() when AI is
 * unconfigured — import always works without a key.
 *
 * Collectors arrive with spreadsheets and competitor exports (FEATURES.md
 * §1.4); headers are unpredictable, so mapping is proposed (AI or heuristics)
 * and always confirmed by the user before anything is written.
 */

export const IMPORT_FIELDS = [
  "name",
  "upc",
  "relationship",
  "status",
  "fillLevel",
  "quantity",
  "purchasePrice",
  "purchaseDate",
  "store",
  "location",
  "notes",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_LABELS: Record<ImportField, string> = {
  name: "Bottle name",
  upc: "UPC / barcode",
  relationship: "Own / tried / wishlist",
  status: "Sealed / open / finished",
  fillLevel: "Fill level %",
  quantity: "Quantity",
  purchasePrice: "Price paid",
  purchaseDate: "Purchase date",
  store: "Store",
  location: "Location / shelf",
  notes: "Notes",
};

/** field → column index into headers/rows, or null when absent. */
export type ColumnMapping = Record<ImportField, number | null>;

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/**
 * Parse CSV/TSV text: quoted fields (with "" escapes), CRLF, BOM, and
 * delimiter sniffing (comma, semicolon, tab — whichever splits the first
 * line most). The first non-empty line is the header row.
 */
export function parseDelimited(text: string): ParsedTable {
  const clean = text.replace(/^\uFEFF/, "");
  const counts: Array<[string, number]> = [",", ";", "\t"].map((d) => {
    const firstLine = clean.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    return [d, firstLine.split(d).length - 1];
  });
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 0 ? counts[0][0] : ",";

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.some((c) => c.trim().length > 0)) rows.push(row);
    row = [];
  };
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const [headers = [], ...body] = rows;
  return { headers: headers.map((h) => h.trim()), rows: body };
}

const FIELD_PATTERNS: Array<[ImportField, RegExp]> = [
  ["upc", /\b(upc|barcode|bar code|ean|gtin)\b/i],
  ["purchasePrice", /(purchase.?price|price.?paid|paid|cost|price|amount|spent)/i],
  ["purchaseDate", /(purchase.?date|date.?(purchased|acquired|bought|added)|acquired|bought|^date$)/i],
  ["store", /\b(store|shop|retailer|merchant|seller|where)\b/i],
  ["quantity", /^(qty|quantity|count|bottles|#)$/i],
  ["fillLevel", /(fill|remaining|level)/i],
  ["status", /^(status|state|sealed|opened?)$/i],
  ["relationship", /^(relationship|list|type|shelf type)$/i],
  ["location", /\b(location|shelf|cabinet|bin|room)\b/i],
  ["notes", /(note|comment|remark|review)/i],
  ["name", /(name|bottle|whisk|product|title|expression|label|item)/i],
];

/**
 * Best-effort mapping from header names. Order matters: specific fields claim
 * their columns before the greedy name pattern; each column maps at most once.
 */
export function heuristicMapping(headers: string[]): ColumnMapping {
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as ColumnMapping;
  const taken = new Set<number>();
  for (const [f, re] of FIELD_PATTERNS) {
    if (mapping[f] !== null) continue;
    const idx = headers.findIndex((h, i) => !taken.has(i) && re.test(h.trim()));
    if (idx >= 0) {
      mapping[f] = idx;
      taken.add(idx);
    }
  }
  // Fallback: a single-column sheet is a list of bottle names (unless another
  // field already claimed that column).
  if (mapping.name === null && headers.length === 1 && !taken.has(0)) mapping.name = 0;
  return mapping;
}

export interface NormalizedImportRow {
  name: string | null;
  upc: string | null;
  relationship: Relationship;
  status: BottleStatus | null;
  fillLevel: number | null;
  quantity: number | null;
  purchasePrice: number | null;
  /** ISO string, ready for the API. */
  purchaseDate: string | null;
  store: string | null;
  location: string | null;
  notes: string | null;
}

const RELATIONSHIP_SYNONYMS: Array<[RegExp, Relationship]> = [
  [/^(own|owned|have|got|bar|shelf|collection|in stock)/i, "own"],
  [/^(wish|want|wtb|hunting|grail)/i, "wishlist"],
  [/^(tried|tasted|sampled|drank|had)/i, "tried"],
];

const STATUS_SYNONYMS: Array<[RegExp, BottleStatus]> = [
  [/^(sealed|unopened|closed|new|full)/i, "sealed"],
  [/^(open|opened|drinking|in progress)/i, "open"],
  [/^(finished|empty|killed|dead|done)/i, "finished"],
  [/^sold/i, "sold"],
  [/^traded/i, "traded"],
  [/^gift/i, "gifted"],
];

function cell(rowValues: string[], idx: number | null): string | null {
  if (idx === null || idx < 0 || idx >= rowValues.length) return null;
  const v = rowValues[idx].trim();
  return v.length > 0 ? v : null;
}

/** Apply a confirmed mapping to one raw row and normalize every value. */
export function normalizeImportRow(
  rowValues: string[],
  mapping: ColumnMapping,
  defaultRelationship: Relationship = "own",
): NormalizedImportRow {
  const raw = (f: ImportField) => cell(rowValues, mapping[f]);

  let relationship: Relationship = defaultRelationship;
  const relRaw = raw("relationship");
  if (relRaw) {
    if ((RELATIONSHIPS as readonly string[]).includes(relRaw.toLowerCase())) {
      relationship = relRaw.toLowerCase() as Relationship;
    } else {
      const hit = RELATIONSHIP_SYNONYMS.find(([re]) => re.test(relRaw));
      if (hit) relationship = hit[1];
    }
  }

  let status: BottleStatus | null = null;
  const statusRaw = raw("status");
  if (statusRaw) {
    if ((BOTTLE_STATUSES as readonly string[]).includes(statusRaw.toLowerCase())) {
      status = statusRaw.toLowerCase() as BottleStatus;
    } else {
      status = STATUS_SYNONYMS.find(([re]) => re.test(statusRaw))?.[1] ?? null;
    }
  }

  const priceRaw = raw("purchasePrice");
  const price = priceRaw ? Number.parseFloat(priceRaw.replace(/[$€£,\s]/g, "")) : NaN;

  const dateRaw = raw("purchaseDate");
  const dateMs = dateRaw ? Date.parse(dateRaw) : NaN;

  const fillRaw = raw("fillLevel");
  const fill = fillRaw ? Number.parseFloat(fillRaw.replace(/%/g, "")) : NaN;

  const qtyRaw = raw("quantity");
  const qty = qtyRaw ? Number.parseInt(qtyRaw, 10) : NaN;

  return {
    name: raw("name"),
    upc: raw("upc"),
    relationship,
    status,
    fillLevel: Number.isFinite(fill) ? Math.min(100, Math.max(0, Math.round(fill))) : null,
    quantity: Number.isFinite(qty) && qty >= 1 ? qty : null,
    purchasePrice: Number.isFinite(price) && price >= 0 ? price : null,
    purchaseDate: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
    store: raw("store"),
    location: raw("location"),
    notes: raw("notes"),
  };
}
