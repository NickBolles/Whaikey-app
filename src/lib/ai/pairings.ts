import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { DB } from "@/db";
import { recordAiUsage } from "@/lib/ai/usage";
import * as schema from "@/db/schema";
import { chatModel, getAnthropic, isAiConfigured } from "./client";
import { parseModelJson, textFromContent } from "./json";

export type PairingRow = schema.Pairing;
const PAIRING_LEASE_MS = 60_000;
const PAIRING_WAIT_MS = 25;

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
  /**
   * Who asked, for cost attribution (PLAN-A3). Optional because generation is
   * cached per bottle and shared: the first person to ask pays for everybody,
   * which is a real property of the feature and not a rounding error, so the
   * row records who triggered it rather than pretending the cost was spread.
   */
  requestedBy?: string | null,
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

  // A process-local promise map cannot protect serverless/concurrent instances.
  // Use a DB lease; waiters serve the cache as soon as the lease holder commits.
  const deadline = Date.now() + PAIRING_LEASE_MS;
  while (Date.now() < deadline) {
    const token = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_LEASE_MS);
    const [lease] = await db
      .insert(schema.pairingGenerationLocks)
      .values({ bottleId, token, expiresAt })
      .onConflictDoUpdate({
        target: schema.pairingGenerationLocks.bottleId,
        set: { token, expiresAt },
        where: lte(schema.pairingGenerationLocks.expiresAt, now),
      })
      .returning({ token: schema.pairingGenerationLocks.token });
    if (lease?.token === token) {
      try {
        // A concurrent cache-miss caller can acquire after the original
        // generator has committed its rows but before it observed the cache.
        // The lease serializes generation only when the persisted cache is
        // still empty.
        const refreshed = await db
          .select()
          .from(schema.pairings)
          .where(eq(schema.pairings.bottleId, bottleId));
        if (refreshed.length > 0) return refreshed;
        return await generatePairings(db, bottle, client, requestedBy);
      } finally {
        await db
          .delete(schema.pairingGenerationLocks)
          .where(and(eq(schema.pairingGenerationLocks.bottleId, bottleId), eq(schema.pairingGenerationLocks.token, token)));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, PAIRING_WAIT_MS));
    const rows = await getCachedPairings(db, bottleId);
    if (rows && rows.length > 0) return rows;
  }
  // A crashed holder's expired lease will be recovered by the next request;
  // don't make a waiting caller spin indefinitely.
  return [];
}

export async function getCachedPairings(db: DB, bottleId: string): Promise<PairingRow[] | null> {
  const [bottle] = await db.select({ id: schema.bottles.id }).from(schema.bottles).where(eq(schema.bottles.id, bottleId)).limit(1);
  if (!bottle) return null;
  return db.select().from(schema.pairings).where(eq(schema.pairings.bottleId, bottleId));
}

async function generatePairings(
  db: DB,
  bottle: schema.Bottle,
  client?: Anthropic,
  requestedBy?: string | null,
): Promise<PairingRow[]> {
  const anthropic = client ?? (isAiConfigured() ? getAnthropic() : null);
  if (!anthropic) return [];

  const model = chatModel();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: buildPrompt(bottle) }],
  });
  await recordAiUsage(db, {
    userId: requestedBy ?? null,
    feature: "pairings",
    model,
    usage: response.usage,
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
        bottleId: bottle.id,
        pairingType: p.pairingType,
        suggestion: p.suggestion,
        rationale: p.rationale || null,
        source: "ai" as const,
      })),
    )
    .returning();
  return inserted;
}
