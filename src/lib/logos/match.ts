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
 *    bottle's own name STARTS with ("Glenfiddich 12 Year" → glenfiddich).
 *    Generic one-word names ("Old", "John", "Single") never match.
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
}

export interface BrandIndex {
  /** core-name → brand key, longest first when matching. */
  byCore: Map<string, string>;
  cores: string[];
  byDistillery: Map<string, string>;
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
  return { byCore, cores, byDistillery };
}

/** The brand key a bottle is filed under, or null for no confident match. */
export function matchBottleBrand(
  bottle: { name: string; distilleryId?: string | null },
  index: BrandIndex,
): string | null {
  if (bottle.distilleryId) {
    const viaDistillery = index.byDistillery.get(bottle.distilleryId);
    if (viaDistillery) return viaDistillery;
  }
  const name = ` ${coreName(bottle.name)} `;
  for (const core of index.cores) {
    if (name.startsWith(` ${core} `)) return index.byCore.get(core)!;
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
