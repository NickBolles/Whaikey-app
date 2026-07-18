import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { chatModel, getAnthropic, isAiConfigured } from "./client";
import { parseModelJson, textFromContent } from "./json";

export type PairingRow = schema.Pairing;

interface GeneratedPairing {
  pairingType: "food" | "cocktail";
  suggestion: string;
  rationale: string;
}

function buildPrompt(bottle: schema.Bottle): string {
  const profile = bottle.flavorProfile ? JSON.stringify(bottle.flavorProfile) : "unknown";
  const facts = [
    `Name: ${bottle.name}`,
    `Category: ${bottle.category}`,
    bottle.ageYears != null ? `Age: ${bottle.ageYears} years` : null,
    bottle.abv != null ? `ABV: ${bottle.abv}%` : null,
    bottle.caskTypes?.length ? `Casks: ${bottle.caskTypes.join(", ")}` : null,
    `Flavor profile (wedge 0-10): ${profile}`,
    bottle.description ? `Description: ${bottle.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "You are a whiskey pairing expert. Suggest pairings for this whiskey:",
    facts,
    "",
    "Return STRICT JSON only — an array of 3 to 7 objects, no prose, no markdown fences:",
    '[{"pairingType": "food" | "cocktail", "suggestion": "short name", "rationale": "one-line reason grounded in the flavor profile"}]',
    "",
    "Rules: include 3-5 food pairings. Add 1-2 cocktail suggestions only when the flavor profile suits mixing (skip cocktails for delicate or rare sippers). Ground every rationale in the flavor profile above. No health claims.",
  ].join("\n");
}

/**
 * Return cached pairings for a bottle; when the cache is empty and AI is
 * configured, generate 3-5 food (+ optional cocktails), insert with source
 * "ai", and return them. Returns null for an unknown bottle. Returns [] when
 * the cache is empty and AI is not configured.
 */
export async function getOrGeneratePairings(
  db: DB,
  bottleId: string,
  client?: Anthropic,
): Promise<PairingRow[] | null> {
  const [bottle] = await db
    .select()
    .from(schema.bottles)
    .where(eq(schema.bottles.id, bottleId))
    .limit(1);
  if (!bottle) return null;

  const cached = await db
    .select()
    .from(schema.pairings)
    .where(eq(schema.pairings.bottleId, bottleId));
  if (cached.length > 0) return cached;

  const anthropic = client ?? (isAiConfigured() ? getAnthropic() : null);
  if (!anthropic) return [];

  const response = await anthropic.messages.create({
    model: chatModel(),
    max_tokens: 2048,
    messages: [{ role: "user", content: buildPrompt(bottle) }],
  });

  const parsed = parseModelJson(textFromContent(response.content as never));
  if (!Array.isArray(parsed)) return [];

  const valid: GeneratedPairing[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    const pairingType = p.pairingType === "food" || p.pairingType === "cocktail" ? p.pairingType : null;
    const suggestion = typeof p.suggestion === "string" ? p.suggestion.trim() : "";
    const rationale = typeof p.rationale === "string" ? p.rationale.trim() : "";
    if (!pairingType || !suggestion) continue;
    valid.push({ pairingType, suggestion, rationale });
  }
  if (valid.length === 0) return [];

  const inserted = await db
    .insert(schema.pairings)
    .values(
      valid.map((p) => ({
        id: randomUUID(),
        bottleId,
        pairingType: p.pairingType,
        suggestion: p.suggestion,
        rationale: p.rationale || null,
        source: "ai" as const,
      })),
    )
    .returning();
  return inserted;
}
