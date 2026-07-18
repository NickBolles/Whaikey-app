import type Anthropic from "@anthropic-ai/sdk";
import { FLAVOR_WHEEL, isValidLeaf } from "@/lib/flavor-wheel";
import { SERVING_STYLES, type ServingStyle } from "@/db/schema";
import { fastModel, getAnthropic } from "./client";
import { parseModelJson, textFromContent } from "./json";

export interface ExtractedTastingNote {
  nose: string | null;
  palate: string | null;
  finish: string | null;
  /** leaf id -> intensity 1-3 (validated against the flavor wheel) */
  flavorTags: Record<string, number>;
  /** 0.5-5.0 in half-star steps, or null */
  suggestedRating: number | null;
  servingStyle: ServingStyle | null;
}

const EMPTY: ExtractedTastingNote = {
  nose: null,
  palate: null,
  finish: null,
  flavorTags: {},
  suggestedRating: null,
  servingStyle: null,
};

const TAXONOMY = FLAVOR_WHEEL.map(
  (w) => `${w.label} (${w.id}): ${w.leaves.map((l) => `${l.id} ("${l.label}")`).join(", ")}`,
).join("\n");

function buildPrompt(text: string): string {
  return [
    "Extract a structured whiskey tasting note from the user's freeform (possibly voice-dictated) note below.",
    "",
    "Flavor taxonomy — flavorTags keys MUST be leaf ids from this list only:",
    TAXONOMY,
    "",
    "Return STRICT JSON only, no prose, no markdown fences, with exactly this shape:",
    `{"nose": string|null, "palate": string|null, "finish": string|null, "flavorTags": {"<leafId>": 1|2|3, ...}, "suggestedRating": number|null, "servingStyle": ${SERVING_STYLES.map((s) => `"${s}"`).join("|")}|null}`,
    "",
    "Rules:",
    "- nose/palate/finish: short phrases quoting or paraphrasing the note; null when the note doesn't cover that stage.",
    "- flavorTags: intensity 1 (hint) to 3 (dominant). Only include flavors the note actually mentions.",
    "- suggestedRating: only if the note states or strongly implies a score out of 5; otherwise null. Use half-star steps (0.5-5.0).",
    "- servingStyle: only if mentioned (neat, rocks, splash of water, cocktail, highball); otherwise null.",
    "",
    "Tasting note:",
    text,
  ].join("\n");
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampRating(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const half = Math.round(n * 2) / 2;
  return Math.min(5, Math.max(0.5, half));
}

function cleanServingStyle(value: unknown): ServingStyle | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return (SERVING_STYLES as readonly string[]).includes(lowered)
    ? (lowered as ServingStyle)
    : null;
}

/**
 * Turn a freeform/voice tasting note into a structured note using the fast
 * model. Parses defensively: markdown fences are stripped, invalid flavor-wheel
 * leaves dropped, intensities clamped to 1-3, and ratings clamped to 0.5-5
 * half steps. Returns an all-null note when the model output is unusable.
 */
export async function extractTastingNote(
  text: string,
  client?: Anthropic,
): Promise<ExtractedTastingNote> {
  const anthropic = client ?? getAnthropic();
  const response = await anthropic.messages.create({
    model: fastModel(),
    max_tokens: 1500,
    messages: [{ role: "user", content: buildPrompt(text) }],
  });

  const parsed = parseModelJson(textFromContent(response.content as never));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...EMPTY };
  }
  const raw = parsed as Record<string, unknown>;

  const flavorTags: Record<string, number> = {};
  if (typeof raw.flavorTags === "object" && raw.flavorTags !== null) {
    for (const [leafId, intensity] of Object.entries(raw.flavorTags as Record<string, unknown>)) {
      if (!isValidLeaf(leafId)) continue;
      const n = typeof intensity === "number" ? intensity : Number(intensity);
      if (!Number.isFinite(n)) continue;
      flavorTags[leafId] = Math.min(3, Math.max(1, Math.round(n)));
    }
  }

  return {
    nose: cleanString(raw.nose),
    palate: cleanString(raw.palate),
    finish: cleanString(raw.finish),
    flavorTags,
    suggestedRating: clampRating(raw.suggestedRating),
    servingStyle: cleanServingStyle(raw.servingStyle),
  };
}
