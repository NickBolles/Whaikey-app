/**
 * The canonical Scotch region set — the shared contract behind anything that
 * counts, teaches, or filters by region, the way src/lib/flavor-wheel.ts is the
 * contract for descriptors. Do not hard-code a region list anywhere else.
 *
 * **There are two true numbers, and conflating them is the bug this file
 * exists to prevent.** The Scotch Whisky Regulations 2009 protect *five*
 * localities — Speyside, Highland, Lowland, Islay, Campbeltown — and formally
 * fold the islands into the Highlands. Nearly every drinker, retailer and
 * shelf-talker nonetheless treats **Islands** as a region of its own, and so
 * does our catalog: `bottles.region` and `distilleries.region` store
 * `"Islands"` for Highland Park, Talisker, Arran, Jura and Tobermory.
 *
 * So the product counts **six**, because six is what the data says and what a
 * bottle page shows; the lesson still teaches that five of them are protected,
 * because that's the fact. `SCOTCH_REGION_COUNT` is the denominator for a
 * passport counter or a completion badge — never a literal.
 */

export interface ScotchRegion {
  /** Exactly the string stored in `bottles.region` / `distilleries.region`. */
  id: string;
  label: string;
  /** One of the five localities protected by the Scotch Whisky Regulations 2009. */
  isProtected: boolean;
  /** One line of orientation, shared by the regions lesson and region surfaces. */
  blurb: string;
}

/**
 * Tour order, not alphabetical: it runs densest-to-scattered the way the
 * regions lesson walks them, and lands on Islands last — which is also the
 * honest place for the one region that isn't legally protected.
 */
export const SCOTCH_REGIONS: readonly ScotchRegion[] = [
  {
    id: "Speyside",
    label: "Speyside",
    isProtected: true,
    blurb:
      "the densest cluster of distilleries in the world; orchard fruit, honey, and elegant sherried malts.",
  },
  {
    id: "Highland",
    label: "Highland",
    isProtected: true,
    blurb:
      "the biggest and most varied region: heather and honey in the south, dry spice in the north, salt at the coasts.",
  },
  {
    id: "Lowland",
    label: "Lowland",
    isProtected: true,
    blurb: "traditionally gentle, grassy, and light; a classic first-Scotch region.",
  },
  {
    id: "Islay",
    label: "Islay",
    isProtected: true,
    blurb: "peat smoke, brine, and iodine; small island, enormous flavors.",
  },
  {
    id: "Campbeltown",
    label: "Campbeltown",
    isProtected: true,
    blurb:
      'once "the whisky capital of the world", now a tiny, cultish region of oily, briny, lightly funky malts.',
  },
  {
    id: "Islands",
    label: "Islands",
    isProtected: false,
    blurb: "Orkney to Arran: heathery smoke, sea spray, and everything between.",
  },
] as const;

/**
 * What a blend carries in the region column. A blended Scotch is married from
 * several regions and belongs to none, so the catalog stores the country there
 * — right for a bottle page ("Scotland · 40% ABV"), and *not* a region.
 * `isScotchRegion` returns false for it deliberately: a passport counter that
 * accepted this would hand someone a seventh region for buying Johnnie Walker.
 */
export const SCOTCH_BLEND_REGION = "Scotland";

/** Six — the passport denominator. Never write the number by hand. */
export const SCOTCH_REGION_COUNT = SCOTCH_REGIONS.length;

/** Five — the count the regulations protect, for copy that makes that claim. */
export const PROTECTED_SCOTCH_REGION_COUNT = SCOTCH_REGIONS.filter((r) => r.isProtected).length;

const BY_ID = new Map(SCOTCH_REGIONS.map((r) => [r.id, r]));

export function isScotchRegion(region: string | null | undefined): boolean {
  return region != null && BY_ID.has(region);
}

export function scotchRegion(region: string | null | undefined): ScotchRegion | null {
  return region == null ? null : (BY_ID.get(region) ?? null);
}
