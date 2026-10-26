import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import { buildEnrichPrompt, type EnrichableBottle } from "@/lib/ingest/enrich";

/**
 * Prompts for in-app enrichment. Kept beside the validator (validate.ts) so
 * the shape asked for and the shape accepted can't drift apart.
 */

export interface PromptBottle {
  id: string;
  name: string;
  category: string;
  distillery: string | null;
  country: string | null;
  region: string | null;
  abv: number | null;
  ageYears: number | null;
  description: string | null;
}

function enrichable(b: PromptBottle): EnrichableBottle {
  return {
    id: b.id,
    name: b.name,
    category: b.category,
    distillery: b.distillery,
    region: b.region ?? b.country,
    abv: b.abv,
    ageYears: b.ageYears,
    description: b.description?.slice(0, 600) ?? null,
    // User notes are never sent to the model (docs/DATA_SOURCES.md §2.4a).
    userNotes: [],
  };
}

/** Small model, no tools: the same prompt the backfill's cheap pass uses, for one bottle. */
export function quickPrompt(b: PromptBottle): string {
  return buildEnrichPrompt([enrichable(b)], false);
}

const LEAF_IDS = FLAVOR_WHEEL.flatMap((w) => w.leaves.map((l) => l.id)).join(", ");
const WEDGES = FLAVOR_WHEEL.map((w) => w.id).join(", ");

/** Stronger model with web search: profile + sourced tasting notes + stated specs. */
export function webPrompt(b: PromptBottle): string {
  const bottle = JSON.stringify({
    name: b.name,
    category: b.category,
    distillery: b.distillery ?? undefined,
    country: b.country ?? undefined,
    region: b.region ?? undefined,
    abv: b.abv ?? undefined,
    ageYears: b.ageYears ?? undefined,
  });
  return [
    "You are a whiskey research assistant with a web search tool. Research this exact bottling:",
    bottle,
    "",
    "Run at most 3 web searches (producer page, retailer listings, published reviews). Then return STRICT JSON only — no prose, no markdown fences — in exactly this shape:",
    `{"profile": {${WEDGES.split(", ").map((w) => `"${w}": n`).join(", ")}}, "notes": {"nose": "...", "palate": "...", "finish": "..."}, "leaves": ["..."], "details": {"abv": n, "ageYears": n, "caskTypes": ["..."], "mashBill": "...", "country": "..."}, "sources": [{"url": "https://...", "label": "Site name"}]}`,
    "",
    "Rules:",
    "- profile: integers 0-10 per wedge (0 = absent, 10 = dominant), grounded in what the sources say; a typical-for-style estimate when they say little. Most whiskies score 0 for peaty unless smoke is expected.",
    "- notes: short descriptor phrases (at most 20 words each) summarising what the published sources say. Paraphrase; never quote a review verbatim. If you found no published tasting notes, set notes to null.",
    `- leaves: up to 10 descriptor ids, only from this list: ${LEAF_IDS}.`,
    "- details: only values a source states for this bottling; use null for anything you did not find. Never include prices, availability or ratings.",
    "- sources: the https pages you actually used (at most 6). An empty list means nothing was found.",
  ].join("\n");
}
