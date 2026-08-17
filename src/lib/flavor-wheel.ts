/**
 * The Whaikey flavor wheel taxonomy: 8 core wedges, each with leaf
 * descriptors. Wedge ids are the keys of bottle.flavorProfile; leaf ids are
 * the keys of tastingNotes.flavorTags. Shared by the wheel UI, note capture,
 * AI extraction, and the palate model — do not rename ids casually.
 */

export interface FlavorWedge {
  id: string;
  label: string;
  color: string;
  leaves: Array<{ id: string; label: string }>;
}

export const FLAVOR_WHEEL: FlavorWedge[] = [
  {
    id: "fruity",
    label: "Fruity",
    color: "#e05d5d",
    leaves: [
      { id: "green-apple", label: "Green apple" },
      { id: "pear", label: "Pear" },
      { id: "citrus", label: "Citrus" },
      { id: "orange-peel", label: "Orange peel" },
      { id: "cherry", label: "Cherry" },
      { id: "dark-fruit", label: "Dark fruit" },
      { id: "raisin", label: "Raisin / fig" },
      { id: "banana", label: "Banana" },
      { id: "tropical", label: "Tropical fruit" },
    ],
  },
  {
    id: "floral",
    label: "Floral",
    color: "#c883d6",
    leaves: [
      { id: "heather", label: "Heather" },
      { id: "rose", label: "Rose" },
      { id: "lavender", label: "Lavender" },
      { id: "grassy", label: "Fresh cut grass" },
      { id: "herbal", label: "Herbal" },
      { id: "mint", label: "Mint" },
    ],
  },
  {
    id: "grain",
    label: "Grain",
    color: "#d6b656",
    leaves: [
      { id: "cereal", label: "Cereal / porridge" },
      { id: "malt", label: "Malt" },
      { id: "biscuit", label: "Biscuit" },
      { id: "fresh-bread", label: "Fresh bread" },
      { id: "corn", label: "Sweet corn" },
      { id: "rye-spice", label: "Rye bread" },
    ],
  },
  {
    id: "sweet",
    label: "Sweet",
    color: "#e8a13c",
    leaves: [
      { id: "vanilla", label: "Vanilla" },
      { id: "caramel", label: "Caramel" },
      { id: "toffee", label: "Toffee" },
      { id: "honey", label: "Honey" },
      { id: "maple", label: "Maple syrup" },
      { id: "brown-sugar", label: "Brown sugar" },
      { id: "chocolate", label: "Chocolate" },
      { id: "butterscotch", label: "Butterscotch" },
    ],
  },
  {
    id: "woody",
    label: "Woody",
    color: "#9c6b3f",
    leaves: [
      { id: "oak", label: "Oak" },
      { id: "char", label: "Char / toast" },
      { id: "cedar", label: "Cedar" },
      { id: "tobacco", label: "Tobacco" },
      { id: "leather", label: "Leather" },
      { id: "nutty", label: "Nutty" },
      { id: "coffee", label: "Coffee" },
    ],
  },
  {
    id: "spicy",
    label: "Spicy",
    color: "#cf5b2e",
    leaves: [
      { id: "black-pepper", label: "Black pepper" },
      { id: "cinnamon", label: "Cinnamon" },
      { id: "clove", label: "Clove" },
      { id: "nutmeg", label: "Nutmeg" },
      { id: "ginger", label: "Ginger" },
      { id: "anise", label: "Anise / licorice" },
      { id: "chili", label: "Chili heat" },
    ],
  },
  {
    id: "peaty",
    label: "Peaty / Smoky",
    color: "#5b6b74",
    leaves: [
      { id: "campfire", label: "Campfire smoke" },
      { id: "peat", label: "Earthy peat" },
      { id: "medicinal", label: "Medicinal / iodine" },
      { id: "brine", label: "Brine / seaweed" },
      { id: "ash", label: "Ash" },
      { id: "tar", label: "Tar" },
      { id: "bbq", label: "BBQ / smoked meat" },
    ],
  },
  {
    id: "feinty",
    label: "Feinty",
    color: "#7d8a5c",
    leaves: [
      { id: "sulfur", label: "Sulfur / struck match" },
      { id: "meaty", label: "Meaty" },
      { id: "waxy", label: "Waxy" },
      { id: "musty", label: "Musty / dunnage" },
      { id: "funky", label: "Funky" },
    ],
  },
];

export const WEDGE_IDS = FLAVOR_WHEEL.map((w) => w.id);

const leafToWedgeMap = new Map<string, string>();
const leafLabelMap = new Map<string, string>();
for (const wedge of FLAVOR_WHEEL) {
  for (const leaf of wedge.leaves) {
    leafToWedgeMap.set(leaf.id, wedge.id);
    leafLabelMap.set(leaf.id, leaf.label);
  }
}

export function wedgeForLeaf(leafId: string): string | undefined {
  return leafToWedgeMap.get(leafId);
}

const leafOrderMap = new Map<string, number>();
{
  let order = 0;
  for (const wedge of FLAVOR_WHEEL) {
    for (const leaf of wedge.leaves) leafOrderMap.set(leaf.id, order++);
  }
}

/**
 * The strongest flavors in a tag record, for compact chip rows: intensity
 * descending, wheel order as the stable tiebreak, unknown ids dropped.
 */
export function topFlavorTags(
  tags: Record<string, number> | null | undefined,
  limit = 3,
): Array<{ leafId: string; intensity: number }> {
  return Object.entries(tags ?? {})
    .filter(([leafId, intensity]) => leafToWedgeMap.has(leafId) && intensity > 0)
    .sort(
      (a, b) =>
        b[1] - a[1] || (leafOrderMap.get(a[0]) ?? 0) - (leafOrderMap.get(b[0]) ?? 0),
    )
    .slice(0, limit)
    .map(([leafId, intensity]) => ({ leafId, intensity }));
}

export function leafLabel(leafId: string): string | undefined {
  return leafLabelMap.get(leafId);
}

export function isValidLeaf(leafId: string): boolean {
  return leafToWedgeMap.has(leafId);
}

/**
 * Search phrases per leaf: the display label (split on "/" so "Raisin / fig"
 * matches either word) plus the id read as words, which supplies useful
 * synonyms — id "grassy" catches a note that never says "fresh cut grass".
 */
const leafPhrases = new Map<string, string[]>();
for (const wedge of FLAVOR_WHEEL) {
  for (const leaf of wedge.leaves) {
    const phrases = new Set<string>();
    for (const part of [...leaf.label.split("/"), leaf.id.replace(/-/g, " ")]) {
      const normalized = part.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (normalized) phrases.add(normalized);
    }
    leafPhrases.set(leaf.id, [...phrases]);
  }
}

/**
 * Leaf ids literally named in a piece of text, in wheel order.
 *
 * A deliberately dumb, synchronous first pass over a tasting note: most notes
 * ("loads of vanilla and charred oak") name their flavors outright, so the UI
 * can show and offer those tags immediately instead of waiting on the model.
 * It is a floor, not a replacement — AI extraction still catches paraphrase,
 * intensity, and structure. Matching is word-boundary on a normalized string
 * with a tolerated plural/adjectival suffix, so "oaky", "raisins" and "toasted"
 * hit while "peatland" does not become "peat".
 */
const SUFFIXES = ["", "s", "es", "y", "d", "ed"];

export function matchLeafIds(text: string): string[] {
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  if (haystack.trim().length === 0) return [];
  const found: string[] = [];
  for (const [leafId, phrases] of leafPhrases) {
    const hit = phrases.some((phrase) =>
      SUFFIXES.some((suffix) => haystack.includes(` ${phrase}${suffix} `)),
    );
    if (hit) found.push(leafId);
  }
  return found;
}

/**
 * Raise each wedge to at least the heat of its hottest leaf.
 *
 * The wheel's two rings are normalized against different denominators — the
 * hottest wedge and the hottest leaf — so nothing otherwise stops the
 * brightest leaf on the wheel from sitting inside a barely-lit family. Every
 * producer of wheel heat has to reconcile them, so the rule lives here rather
 * than being re-derived per call site. Returns a new map; inputs are untouched.
 */
export function floorWedgesAtLeaves(
  wedges: Record<string, number>,
  leaves: Record<string, number>,
): Record<string, number> {
  const out = { ...wedges };
  for (const [leafId, heat] of Object.entries(leaves)) {
    const wedgeId = wedgeForLeaf(leafId);
    if (!wedgeId) continue;
    if (heat > (out[wedgeId] ?? 0)) out[wedgeId] = heat;
  }
  return out;
}

/**
 * Roll leaf-level tags ({leafId: intensity 1-3}) up to wedge-level scores
 * (0-10 scale), for radar displays and the palate model.
 */
export function rollUpToWedges(flavorTags: Record<string, number>): Record<string, number> {
  const wedgeScores: Record<string, number> = {};
  for (const [leafId, intensity] of Object.entries(flavorTags)) {
    const wedgeId = wedgeForLeaf(leafId);
    if (!wedgeId) continue;
    wedgeScores[wedgeId] = (wedgeScores[wedgeId] ?? 0) + intensity;
  }
  for (const wedgeId of Object.keys(wedgeScores)) {
    wedgeScores[wedgeId] = Math.min(10, Math.round(wedgeScores[wedgeId] * 2.5 * 10) / 10);
  }
  return wedgeScores;
}
