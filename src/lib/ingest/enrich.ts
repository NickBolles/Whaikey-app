import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, distilleries } from "@/db/schema";
import { getAnthropic } from "@/lib/ai/client";
import { parseModelJson, textFromContent } from "@/lib/ai/json";
import { FLAVOR_WHEEL, WEDGE_IDS } from "@/lib/flavor-wheel";

/**
 * AI flavor-profile enrichment for catalog bottles without one (the bulk
 * imports from Iowa/COLA, plus user submissions). Runs through the standard
 * Anthropic seam (src/lib/ai/client.ts): no key ⇒ AiNotConfiguredError with a
 * clear CLI message, and nothing in the core loop depends on this ever
 * running.
 *
 * Profiles are 0-10 intensities over the 8 flavor-wheel wedges — the same
 * estimate-quality data the curated seed carries, good enough to make a
 * bottle recommendable. We deliberately do NOT generate descriptions or any
 * other user-facing prose here: profiles feed similarity math, prose would
 * assert facts (per the product guardrails, AI never invents specifics).
 */

/** Model for batch enrichment; override with WHAIKEY_ENRICH_MODEL. */
export function enrichModel(): string {
  return process.env.WHAIKEY_ENRICH_MODEL ?? "claude-opus-4-8";
}

const WEDGE_GUIDE = FLAVOR_WHEEL.map(
  (w) => `${w.id} ("${w.label}"): e.g. ${w.leaves.slice(0, 4).map((l) => l.label.toLowerCase()).join(", ")}`,
).join("\n");

export interface EnrichableBottle {
  id: string;
  name: string;
  category: string;
  distillery: string | null;
  region: string | null;
  abv: number | null;
  ageYears: number | null;
}

export function buildEnrichPrompt(batch: EnrichableBottle[]): string {
  const rows = batch.map((b) =>
    JSON.stringify({
      id: b.id,
      name: b.name,
      category: b.category,
      distillery: b.distillery ?? undefined,
      region: b.region ?? undefined,
      abv: b.abv ?? undefined,
      ageYears: b.ageYears ?? undefined,
    }),
  );
  return [
    "You are a whiskey flavor analyst. For each bottle below, estimate a flavor profile over these 8 wedges, each scored 0-10 (0 = absent, 10 = dominant):",
    WEDGE_GUIDE,
    "",
    "Use what you know about the specific bottle when you recognize it. When you don't recognize it, estimate from its category, distillery house style, region, age, proof, and name cues (e.g. 'Port Cask', 'Peated', 'Bottled-in-Bond') — a typical-for-style estimate is expected and useful.",
    "",
    "Return STRICT JSON only — no prose, no markdown fences — an array with one entry per input bottle:",
    '[{"id": "<bottle id>", "profile": {"fruity": n, "floral": n, "grain": n, "sweet": n, "woody": n, "spicy": n, "peaty": n, "feinty": n}}, ...]',
    "",
    "Rules:",
    "- Include every input id exactly once; never invent ids.",
    "- Every profile must contain all 8 wedge keys with integer scores 0-10.",
    "- Most whiskies score 0 for peaty unless smoke/peat is expected for the style.",
    "",
    "Bottles:",
    ...rows,
  ].join("\n");
}

/** Validate one model-returned profile into a full 8-wedge record, or null. */
export function cleanProfile(raw: unknown): Record<string, number> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const profile: Record<string, number> = {};
  for (const wedge of WEDGE_IDS) {
    const n = typeof source[wedge] === "number" ? (source[wedge] as number) : Number(source[wedge]);
    if (!Number.isFinite(n)) return null;
    profile[wedge] = Math.min(10, Math.max(0, Math.round(n)));
  }
  // Reject all-zero profiles — they'd make cosine similarity meaningless.
  if (Object.values(profile).every((v) => v === 0)) return null;
  return profile;
}

export interface EnrichReport {
  candidates: number;
  batches: number;
  enriched: number;
  /** Bottles a batch failed to enrich (bad shape, unknown id, all-zero, missing wedge). */
  rejected: number;
  dryRun: boolean;
}

export interface EnrichOptions {
  /** Max bottles to enrich this run (default: all without a profile). */
  limit?: number;
  /** Bottles per model request (default 25). */
  batchSize?: number;
  dryRun?: boolean;
  /** Test seam; defaults to the shared getAnthropic() singleton. */
  client?: Anthropic;
  /** Progress callback (batch index, running enriched count). */
  onBatch?: (batch: number, enriched: number) => void;
}

/** Fill flavorProfile for bottles that lack one, in model batches. */
export async function enrichBottleProfiles(db: DB, opts: EnrichOptions = {}): Promise<EnrichReport> {
  const anthropic = opts.client ?? getAnthropic();
  const batchSize = Math.max(1, opts.batchSize ?? 25);

  let targets = await db
    .select({
      id: bottles.id,
      name: bottles.name,
      category: bottles.category,
      distillery: distilleries.name,
      region: bottles.region,
      abv: bottles.abv,
      ageYears: bottles.ageYears,
    })
    .from(bottles)
    .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
    .where(isNull(bottles.flavorProfile))
    .orderBy(bottles.id);
  if (opts.limit != null) targets = targets.slice(0, opts.limit);

  const report: EnrichReport = {
    candidates: targets.length,
    batches: 0,
    enriched: 0,
    rejected: 0,
    dryRun: opts.dryRun ?? false,
  };

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    report.batches += 1;
    const response = await anthropic.messages.create({
      model: enrichModel(),
      max_tokens: 8000,
      messages: [{ role: "user", content: buildEnrichPrompt(batch) }],
    });

    const parsed = parseModelJson(textFromContent(response.content as never));
    const entries = Array.isArray(parsed) ? parsed : [];
    const batchIds = new Set(batch.map((b) => b.id));
    const seen = new Set<string>();

    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, profile } = entry as { id?: unknown; profile?: unknown };
      if (typeof id !== "string" || !batchIds.has(id) || seen.has(id)) continue;
      const clean = cleanProfile(profile);
      if (!clean) continue;
      seen.add(id);
      report.enriched += 1;
      if (!report.dryRun) {
        await db
          .update(bottles)
          .set({ flavorProfile: clean })
          .where(and(eq(bottles.id, id), isNull(bottles.flavorProfile)));
      }
    }
    report.rejected += batch.length - seen.size;
    opts.onBatch?.(report.batches, report.enriched);
  }

  return report;
}
