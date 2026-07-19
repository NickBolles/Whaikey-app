/**
 * AI enrichment for recommendation reasons (PLAN.md §4.6 step 3: "re-ranked and
 * explained by Claude with the user's actual history in context").
 *
 * The ranking + a deterministic reason come from src/lib/recommend.ts and never
 * depend on AI. This module, when a key is configured, replaces each reason with
 * a one-line explanation grounded in the user's own recent pours, and CACHES it
 * per (user, bottle, mode) in rec_explanations so we pay the model cost once.
 * Follows the getOrGeneratePairings caching shape. It never throws into the
 * caller: any AI/parse/DB hiccup falls back to the deterministic reason.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { DB } from "@/db";
import { bottles, pours, recExplanations, tastingNotes } from "@/db/schema";
import type { RecMode } from "@/db/schema";
import type { Recommendation } from "@/lib/recommend";
import { chatModel, getAnthropic, isAiConfigured } from "./client";
import { parseModelJson, textFromContent } from "./json";

/** A few of the user's highest-rated pours, to ground the explanation. */
async function loadUserContext(db: DB, userId: string): Promise<string> {
  const rows = await db
    .select({
      name: bottles.name,
      rating: pours.rating,
      freeform: tastingNotes.freeform,
      nose: tastingNotes.nose,
      palate: tastingNotes.palate,
      finish: tastingNotes.finish,
    })
    .from(pours)
    .innerJoin(bottles, eq(pours.bottleId, bottles.id))
    .leftJoin(tastingNotes, eq(tastingNotes.pourId, pours.id))
    .where(eq(pours.userId, userId))
    .orderBy(desc(pours.rating), desc(pours.createdAt))
    .limit(5);

  const lines = rows.map((r) => {
    const rated = r.rating != null ? `${r.rating}★` : "unrated";
    const note = [r.nose, r.palate, r.finish, r.freeform].filter(Boolean).join("; ");
    return `- ${r.name} (${rated})${note ? ` — ${note}` : ""}`;
  });
  return lines.join("\n");
}

function buildPrompt(mode: RecMode, rec: Recommendation, context: string): string {
  const facts = [
    `Bottle: ${rec.name}`,
    rec.distillery ? `Distillery: ${rec.distillery}` : null,
    `Category: ${rec.category}`,
    rec.region ? `Region: ${rec.region}` : null,
    rec.matchPercent != null ? `Palate match: ${rec.matchPercent}%` : null,
    rec.avgPrice != null ? `Avg price: $${Math.round(rec.avgPrice)}` : null,
    typeof rec.fillLevel === "number" ? `Fill level remaining: ${rec.fillLevel}%` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const intent =
    mode === "tonight"
      ? "This is one of the user's OWN open bottles for a 'what to pour tonight' pick."
      : "This is a NEW bottle we're recommending the user try.";

  return [
    "You write a single, warm, specific one-line reason a whiskey lover should reach for this bottle.",
    intent,
    "",
    "The user's recent, highest-rated pours and notes:",
    context || "(no notes yet)",
    "",
    "This recommendation:",
    facts,
    "",
    "Rules: ONE sentence, under 20 words. Ground it in the user's pours/notes above and this bottle's facts.",
    "Never encourage drinking more or faster, never invent prices or awards, no health claims.",
    'Return STRICT JSON only, no prose: {"reason": "..."}',
  ].join("\n");
}

async function generateReason(
  anthropic: Anthropic,
  mode: RecMode,
  rec: Recommendation,
  context: string,
): Promise<string | null> {
  const response = await anthropic.messages.create({
    model: chatModel(),
    max_tokens: 160,
    messages: [{ role: "user", content: buildPrompt(mode, rec, context) }],
  });
  const text = textFromContent(response.content as never).trim();
  if (!text) return null;

  const parsed = parseModelJson(text);
  let reason = "";
  if (parsed && typeof parsed === "object" && typeof (parsed as { reason?: unknown }).reason === "string") {
    reason = (parsed as { reason: string }).reason;
  } else {
    reason = text;
  }
  reason = reason.replace(/^["']|["']$/g, "").split("\n")[0].trim();
  return reason || null;
}

/**
 * Return the recs with `reason` replaced by a cached or freshly-generated AI
 * explanation. Cache hits never call the model. When AI isn't configured (and no
 * client is injected), the deterministic reasons pass through unchanged. Any
 * failure per-rec keeps that rec's deterministic reason. No AI call for [].
 */
export async function attachAiExplanations(
  db: DB,
  userId: string,
  mode: RecMode,
  recs: Recommendation[],
  client?: Anthropic,
): Promise<Recommendation[]> {
  if (recs.length === 0) return recs;

  const cachedRows = await db
    .select({ bottleId: recExplanations.bottleId, reason: recExplanations.reason })
    .from(recExplanations)
    .where(and(eq(recExplanations.userId, userId), eq(recExplanations.mode, mode)));
  const cache = new Map(cachedRows.map((r) => [r.bottleId, r.reason]));

  const out = recs.map((r) => ({ ...r }));
  const uncached = out.filter((r) => !cache.has(r.bottleId));

  // Apply cache hits first.
  for (const rec of out) {
    const hit = cache.get(rec.bottleId);
    if (hit) rec.reason = hit;
  }
  if (uncached.length === 0) return out;

  const anthropic = client ?? (isAiConfigured() ? getAnthropic() : null);
  if (!anthropic) return out;

  let context = "";
  try {
    context = await loadUserContext(db, userId);
  } catch {
    context = "";
  }

  for (const rec of uncached) {
    try {
      const reason = await generateReason(anthropic, mode, rec, context);
      if (!reason) continue;
      await db
        .insert(recExplanations)
        .values({ id: randomUUID(), userId, bottleId: rec.bottleId, mode, reason })
        .onConflictDoNothing();
      rec.reason = reason;
    } catch {
      // Keep the deterministic reason for this rec.
    }
  }

  return out;
}
