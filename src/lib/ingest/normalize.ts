/**
 * Name/number normalization shared by the ingest adapters. Retail feeds carry
 * packaging and program noise ("Mini", "PET", "DISCO", "w/2 Shot Glasses",
 * "Buy the Barrel") that must never reach the catalog, and matching against
 * the curated seed happens on slugs, so cleaning has to be deterministic.
 */

/** Same slug shape the seed data uses for ids ("Wayne Gretzky No. 99" → "wayne-gretzky-no-99"). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Packaging / retail-program tokens that are noise, not product identity. */
const STRIP_PATTERNS: RegExp[] = [
  /\s+w\/.*$/i, // "w/2 Shot Glasses", "w/Sour Mix" (gift packs)
  /\s+use code \d+.*$/i, // Iowa "USE CODE 28730" bookkeeping notes
  /\s+buy the barrel\b.*$/i, // whole-barrel program listings ("… Buy the Barrel 121pf")
  /\s+gift (tin|pack|set|box)$/i,
  /\s+bag in box$/i,
  /\s+DISCO$/, // Iowa's discontinued marker (uppercase in the feed)
  /\s+mini(ature)?s?$/i,
  /\s+PET$/, // plastic-bottle variant
  /\s+traveler$/i,
  /\s+\d+(\.\d+)?\s*(ml|l|liter|ltr)$/i, // trailing sizes
  /\s+\d+\s*pk$/i,
];

/**
 * Clean a raw product description into a display name. Returns null when
 * nothing usable remains.
 */
export function cleanProductName(raw: string): string | null {
  let name = raw.trim();
  let prev: string;
  do {
    prev = name;
    for (const p of STRIP_PATTERNS) name = name.replace(p, "");
    name = name.trim();
  } while (name !== prev);
  // "16YR" / "16 YR" → "16 Year", matching curated naming.
  name = name.replace(/(\d+)\s*YR\b\.?/gi, "$1 Year");
  name = name.replace(/\s{2,}/g, " ").trim();
  return name.length >= 3 ? name : null;
}

/**
 * Flavored-whiskey markers (cinnamon, apple pie, …). These are skipped: the
 * catalog tracks whiskey, not whiskey-based flavored products, and the
 * curated seed follows the same rule.
 */
const FLAVOR_MARKERS =
  /\b(apple|peach|blackberry|raspberry|strawberry|banana|cherry|vanilla|cinnamon|honey|maple|caramel|salted|toffee|pecan|peanut|butter|chocolate|coffee|espresso|eggnog|egg nog|oatnog|nog|pumpkin|spiced|smores|s'mores|pie|lemonade|sweet tea|hot ?shot|fire(ball)?|flavored|liqueur|cream|creme|cookies)\b/i;

/** True when a product name reads as a flavored whiskey / liqueur-style product. */
export function looksFlavored(name: string): boolean {
  return FLAVOR_MARKERS.test(name);
}

/** US spirits proof → ABV percent; null for missing/implausible values. */
export function proofToAbv(proof: number | string | null | undefined): number | null {
  const n = typeof proof === "string" ? Number(proof) : proof;
  if (n == null || !Number.isFinite(n)) return null;
  const abv = n / 2;
  return abv >= 20 && abv <= 80 ? abv : null;
}

/** Age-statement field → years; null for 0/missing/implausible. */
export function parseAgeYears(age: number | string | null | undefined): number | null {
  const n = typeof age === "string" ? Number(age) : age;
  if (n == null || !Number.isFinite(n)) return null;
  const years = Math.round(n);
  return years >= 1 && years <= 60 ? years : null;
}
