/**
 * Brand matching for the logo pipeline (docs/DATA_SOURCES.md §5.4).
 *
 * Two jobs, both deliberately conservative — a wrong logo on a bottle is worse
 * than the monogram:
 *
 * 1. `pickWikidataEntity`: given one of our brands (name + country), choose the
 *    Wikidata item that is the same producer — exact core-name equality (label
 *    or alias), an allowed instance-of (distillery / alcohol brand / whisky),
 *    and no country contradiction.
 * 2. `matchBottleBrand`: file a catalog bottle under a brand — the distillery
 *    link when there is one, otherwise the longest known brand name the
 *    bottle's own name STARTS with ("Glenfiddich 12 Year" → glenfiddich),
 *    after dropping a leading vintage/age ("1990 Caol Ila" → caol-ila).
 *    Then a curated bottler/range marker anywhere in the name ("Caol Ila
 *    1990 Signatory Vintage", "Old Particular Mortlach" → douglas-laing), and
 *    last a multi-word curated/distillery name anywhere ("Single Cask Caol
 *    Ila 12" → caol-ila). Generic one-word names ("Old", "John", "Single")
 *    never match, and Wikidata-only names only ever match as a prefix.
 */

const STOP_WORDS = new Set([
  "the", "distillery", "distilleries", "distilling", "distillers", "distiller", "company", "co", "inc", "llc",
  "ltd", "limited", "whisky", "whiskey", "sons", "and", "brand",
]);

/** Single-token brand names too common to match on their own. */
const GENERIC = new Set([
  "old", "john", "single", "cask", "malt", "blend", "blended", "reserve", "select", "special", "rare", "small",
  "batch", "barrel", "straight", "bourbon", "rye", "scotch", "irish", "japanese", "canadian", "american", "highland",
  "islay", "speyside", "lowland", "kentucky", "tennessee", "black", "red", "white", "gold", "silver", "royal",
  "crown", "king", "queen", "grand", "great", "first", "high", "new", "big", "little", "wild", "sweet", "spirit",
  "spirits", "craft", "family", "brothers", "label", "edition", "limited", "private", "club", "society", "house",
  "vintage", "classic", "original", "premium", "mountain", "river", "valley", "creek", "lake", "rock", "stone",
  "james", "william", "george", "thomas", "henry", "robert", "charles", "jack", "jim", "tom", "sam", "art",
  "key", "isle", "that", "single malts", "blue", "green", "virgin", "pure", "true", "best", "fine", "smooth",
]);

/** Lower-case ASCII words: "Maker’s Mark" → "makers mark". */
export function normalizeName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`.]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** The distinctive part of a producer name: "The Glenlivet Distillery" → "glenlivet". */
export function coreName(input: string): string {
  return normalizeName(input)
    .split(" ")
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(" ");
}

/** Stable key for a brand row (`brand_logos.key`). */
export function brandKey(name: string): string {
  return coreName(name).replace(/ /g, "-") || normalizeName(name).replace(/ /g, "-");
}

/** Whether a core name is specific enough to match bottle names against. */
export function isMatchableCore(core: string): boolean {
  if (core.length < 3) return false;
  if (/^[0-9 ]+$/.test(core)) return false;
  if (GENERIC.has(core)) return false;
  const words = core.split(" ");
  if (words.length === 1 && core.length < 4) return false;
  return true;
}

export interface BrandRef {
  key: string;
  name: string;
  aliases?: string[];
  distilleryId?: string | null;
  /** Bottler/range names that file a bottle wherever they appear in its name. */
  markers?: string[];
  /** Curated or distillery brand: a multi-word name may match anywhere in a bottle name. */
  anywhere?: boolean;
}

/** Words that make a multi-word name too descriptive to match mid-name. */
const DESCRIPTORS = new Set([
  "year", "years", "yo", "aged", "age", "proof", "strength", "finish", "finished", "port", "sherry", "wood", "oak",
  "release", "collection", "selection", "series", "bottling", "bottled", "distilled", "matured", "single", "malt",
  "grain", "scotch", "bourbon", "rye", "cask", "casks", "barrel", "barrels", "batch", "of", "for", "by", "in",
]);

/** Whether a core may be matched in the middle of a bottle name. */
export function isAnywhereCore(core: string): boolean {
  if (!isMatchableCore(core)) return false;
  const words = core.split(" ");
  if (words.length < 2 || core.length < 7) return false;
  const distinctive = words.filter((w) => !GENERIC.has(w) && !DESCRIPTORS.has(w) && !/^[0-9]+$/.test(w));
  return distinctive.length >= 1 && distinctive.some((w) => w.length >= 4);
}

/** Drop a leading vintage / age so "1990 Caol Ila" and "12 Year Old Caol Ila" prefix-match. */
function stripLeadingNoise(core: string): string {
  return core.replace(/^(?:(?:19|20)[0-9]{2} |[0-9]{1,2} (?:year old |years old |year |yo )?)+/, "");
}

export interface BrandIndex {
  /** core-name → brand key, longest first when matching. */
  byCore: Map<string, string>;
  cores: string[];
  byDistillery: Map<string, string>;
  /** Marker / anywhere cores, longest first. */
  anywhere: Array<{ core: string; key: string; via: "marker" | "anywhere" }>;
}

export function buildBrandIndex(brands: BrandRef[]): BrandIndex {
  const byCore = new Map<string, string>();
  const byDistillery = new Map<string, string>();
  for (const b of brands) {
    if (b.distilleryId) byDistillery.set(b.distilleryId, b.key);
    for (const n of [b.name, ...(b.aliases ?? [])]) {
      const core = coreName(n);
      if (!isMatchableCore(core)) continue;
      // First writer wins: brands are passed curated-first, so a seed's claim
      // to a name beats a later Wikidata alias for the same words.
      if (!byCore.has(core)) byCore.set(core, b.key);
    }
  }
  const cores = [...byCore.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const seen = new Set<string>();
  const anywhere: BrandIndex["anywhere"] = [];
  for (const b of brands) {
    for (const m of b.markers ?? []) {
      const core = coreName(m);
      if (!isMatchableCore(core) || seen.has(core)) continue;
      seen.add(core);
      anywhere.push({ core, key: b.key, via: "marker" });
    }
  }
  for (const b of brands) {
    if (!b.anywhere) continue;
    for (const n of [b.name, ...(b.aliases ?? [])]) {
      const core = coreName(n);
      // Only the brand that owns the core (first writer) may claim it mid-name.
      if (!isAnywhereCore(core) || seen.has(core) || byCore.get(core) !== b.key) continue;
      seen.add(core);
      anywhere.push({ core, key: b.key, via: "anywhere" });
    }
  }
  // Markers before plain names at equal length; longer cores first overall.
  anywhere.sort((a, b) => b.core.length - a.core.length || (a.via === b.via ? a.core.localeCompare(b.core) : a.via === "marker" ? -1 : 1));
  return { byCore, cores, byDistillery, anywhere };
}

export type BrandMatchVia = "distillery" | "prefix" | "marker" | "anywhere";

/** The brand key a bottle is filed under, or null for no confident match. */
export function matchBottleBrand(
  bottle: { name: string; distilleryId?: string | null },
  index: BrandIndex,
): string | null {
  return matchBottleBrandVia(bottle, index)?.key ?? null;
}

/** `matchBottleBrand` plus which rule matched (for the dry-run sample). */
export function matchBottleBrandVia(
  bottle: { name: string; distilleryId?: string | null },
  index: BrandIndex,
): { key: string; via: BrandMatchVia } | null {
  if (bottle.distilleryId) {
    const viaDistillery = index.byDistillery.get(bottle.distilleryId);
    if (viaDistillery) return { key: viaDistillery, via: "distillery" };
  }
  const core = coreName(bottle.name);
  for (const candidate of new Set([core, stripLeadingNoise(core)])) {
    const name = ` ${candidate} `;
    for (const c of index.cores) {
      if (name.startsWith(` ${c} `)) return { key: index.byCore.get(c)!, via: "prefix" };
    }
  }
  const name = ` ${core} `;
  for (const a of index.anywhere ?? []) {
    if (name.includes(` ${a.core} `)) return { key: a.key, via: a.via };
  }
  return null;
}

/** Wikidata classes a producer may be an instance of. */
export const PRODUCER_CLASSES = new Set([
  "Q10373548", // whisky distillery
  "Q1251750", // distillery
  "Q131734", // distillery (building/industry)
  "Q80359036", // alcohol brand
  "Q431289", // brand
  "Q167270", // trademark
  "Q4830453", // business
  "Q6881511", // enterprise
  "Q281", // whisky
  "Q382947", // Scotch whisky
  "Q543127", // bourbon whiskey
  "Q1092577", // Irish whiskey
  "Q1067963", // Japanese whisky
  "Q1185624", // Canadian whisky
  "Q15069964", // rye whiskey
  "Q2424752", // product
]);

export interface WikidataCandidate {
  id: string;
  label: string;
  aliases: string[];
  /** English country labels from P17/P495. */
  countries: string[];
  instanceOf: string[];
}

const COUNTRY_ALIASES: Record<string, string> = {
  "united states": "usa",
  "united states of america": "usa",
  us: "usa",
  "united kingdom": "uk",
  scotland: "uk",
  wales: "uk",
  england: "uk",
  "northern ireland": "uk",
  "republic of ireland": "ireland",
  "taiwan": "taiwan",
  "republic of china": "taiwan",
};

export function normalizeCountry(c: string | null | undefined): string | null {
  if (!c) return null;
  const n = normalizeName(c);
  return COUNTRY_ALIASES[n] ?? n;
}

/**
 * The Wikidata item that is this producer, or null. Ties (two items with
 * the same name and an acceptable class) are refused rather than guessed,
 * except that a whisky-distillery item beats a generic business.
 */
export function pickWikidataEntity<T extends WikidataCandidate>(
  target: { name: string; aliases?: string[]; country?: string | null },
  candidates: T[],
): T | null {
  const wanted = new Set([target.name, ...(target.aliases ?? [])].map(coreName).filter(isMatchableCore));
  const country = normalizeCountry(target.country);
  const ok = candidates.filter((c) => {
    if (!c.instanceOf.some((q) => PRODUCER_CLASSES.has(q))) return false;
    const names = [c.label, ...c.aliases].map(coreName);
    if (!names.some((n) => wanted.has(n))) return false;
    if (country && c.countries.length > 0) {
      const cs = c.countries.map(normalizeCountry);
      if (!cs.includes(country)) return false;
    }
    return true;
  });
  if (ok.length === 0) return null;
  if (ok.length === 1) return ok[0]!;
  const distilleries = ok.filter((c) => c.instanceOf.includes("Q10373548") || c.instanceOf.includes("Q80359036"));
  return distilleries.length === 1 ? distilleries[0]! : null;
}
