import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, distilleries, pours, tastingNotes } from "@/db/schema";
import { getAnthropic } from "@/lib/ai/client";
import { parseModelJson, textFromContent } from "@/lib/ai/json";
import { FLAVOR_WHEEL, WEDGE_IDS, rollUpToWedges } from "@/lib/flavor-wheel";

/**
 * Flavor-profile enrichment for catalog bottles without one (the bulk
 * imports from Iowa/COLA, plus user submissions), in three tiers:
 *
 *  1. Community notes (free, most accurate): bottles with enough user tasting
 *     notes get their profile rolled up directly from the notes' leaf tags —
 *     no model call at all. User palates are the ground truth this app is
 *     built on, so they always win.
 *  2. AI estimate (cheap model): remaining bottles go to the model in
 *     batches, with whatever context we hold — catalog description and user
 *     note snippets — included per bottle.
 *  3. Optional web assist (--web): adds the server-side web search tool so
 *     the model can look up bottles it doesn't recognize before estimating.
 *
 * All model traffic goes through the standard Anthropic seam
 * (src/lib/ai/client.ts): no key ⇒ AiNotConfiguredError with a clear CLI
 * message, and nothing in the core loop depends on this ever running.
 * Output is profiles only — no descriptions or other user-facing prose (per
 * the product guardrails, AI never invents specifics).
 */

/**
 * Model for batch enrichment; override with WHAIKEY_ENRICH_MODEL. Defaults
 * cheap: profile estimation is a bulk classification-style task. Web-assisted
 * runs need a web_search_20260209-capable model, so --web defaults to Sonnet.
 */
export function enrichModel(web = false): string {
  return process.env.WHAIKEY_ENRICH_MODEL ?? (web ? "claude-sonnet-5" : "claude-haiku-4-5-20251001");
}

/** User notes needed before we trust the community roll-up over the model. */
export const COMMUNITY_NOTES_THRESHOLD = 2;

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
  description: string | null;
  /** Condensed user tasting-note context ("nose: ...; palate: ..."), newest first. */
  userNotes: string[];
}

export function buildEnrichPrompt(batch: EnrichableBottle[], web: boolean): string {
  const rows = batch.map((b) =>
    JSON.stringify({
      id: b.id,
      name: b.name,
      category: b.category,
      distillery: b.distillery ?? undefined,
      region: b.region ?? undefined,
      abv: b.abv ?? undefined,
      ageYears: b.ageYears ?? undefined,
      description: b.description ?? undefined,
      userNotes: b.userNotes.length > 0 ? b.userNotes : undefined,
    }),
  );
  return [
    "You are a whiskey flavor analyst. For each bottle below, estimate a flavor profile over these 8 wedges, each scored 0-10 (0 = absent, 10 = dominant):",
    WEDGE_GUIDE,
    "",
    "Ground each profile in the strongest evidence available, in this order:",
    "1. The bottle's userNotes (real tasting notes from this app's users — weigh these heavily).",
    "2. The bottle's description and what you know about the specific bottling.",
    ...(web
      ? [
          "3. For bottles you don't recognize, use web search to find published tasting notes (search at most once per unknown bottle; skip searching for bottles you already know).",
        ]
      : []),
    `${web ? "4" : "3"}. Otherwise estimate from category, distillery house style, region, age, proof, and name cues (e.g. 'Port Cask', 'Peated', 'Bottled-in-Bond') — a typical-for-style estimate is expected and useful.`,
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

interface NoteContext {
  flavorTags: Record<string, number> | null;
  nose: string | null;
  palate: string | null;
  finish: string | null;
}

/**
 * Roll a bottle's user tasting notes into a full 8-wedge profile: average the
 * per-note wedge roll-ups so one enthusiastic note doesn't dominate. Returns
 * null below the note threshold.
 */
export function profileFromNotes(notes: NoteContext[]): Record<string, number> | null {
  const tagged = notes.filter((n) => n.flavorTags && Object.keys(n.flavorTags).length > 0);
  if (tagged.length < COMMUNITY_NOTES_THRESHOLD) return null;
  const sums: Record<string, number> = {};
  for (const note of tagged) {
    const rolled = rollUpToWedges(note.flavorTags!);
    for (const [wedge, score] of Object.entries(rolled)) {
      sums[wedge] = (sums[wedge] ?? 0) + score;
    }
  }
  const profile: Record<string, number> = {};
  for (const wedge of WEDGE_IDS) {
    profile[wedge] = Math.min(10, Math.round((sums[wedge] ?? 0) / tagged.length));
  }
  return Object.values(profile).every((v) => v === 0) ? null : profile;
}

/** Condense a tasting note into one prompt line; null when it has no text signal. */
function noteSnippet(note: NoteContext): string | null {
  const parts = [
    note.nose ? `nose: ${note.nose}` : null,
    note.palate ? `palate: ${note.palate}` : null,
    note.finish ? `finish: ${note.finish}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("; ").slice(0, 300) : null;
}

export interface EnrichReport {
  candidates: number;
  batches: number;
  /** Profiles derived directly from user tasting notes (no model call). */
  fromNotes: number;
  /** Profiles filled by the model. */
  fromAi: number;
  /** Bottles a batch failed to enrich (bad shape, unknown id, all-zero, missing wedge). */
  rejected: number;
  dryRun: boolean;
}

export interface EnrichOptions {
  /** Max bottles to enrich this run (default: all without a profile). */
  limit?: number;
  /** Bottles per model request (default 25; 10 when web search is enabled). */
  batchSize?: number;
  /** Let the model web-search bottles it doesn't recognize (needs a capable model). */
  web?: boolean;
  dryRun?: boolean;
  /** Test seam; defaults to the shared getAnthropic() singleton. */
  client?: Anthropic;
  /** Progress callback (batch index, running enriched count). */
  onBatch?: (batch: number, enriched: number) => void;
}

/** Fill flavorProfile for bottles that lack one: notes first, then the model. */
export async function enrichBottleProfiles(db: DB, opts: EnrichOptions = {}): Promise<EnrichReport> {
  const web = opts.web ?? false;
  const batchSize = Math.max(1, opts.batchSize ?? (web ? 10 : 25));

  let targets = await db
    .select({
      id: bottles.id,
      name: bottles.name,
      category: bottles.category,
      distillery: distilleries.name,
      region: bottles.region,
      abv: bottles.abv,
      ageYears: bottles.ageYears,
      description: bottles.description,
    })
    .from(bottles)
    .leftJoin(distilleries, eq(bottles.distilleryId, distilleries.id))
    .where(isNull(bottles.flavorProfile))
    .orderBy(bottles.id);
  if (opts.limit != null) targets = targets.slice(0, opts.limit);

  const report: EnrichReport = {
    candidates: targets.length,
    batches: 0,
    fromNotes: 0,
    fromAi: 0,
    rejected: 0,
    dryRun: opts.dryRun ?? false,
  };
  if (targets.length === 0) return report;

  // All user tasting notes for profile-less bottles, newest first.
  const noteRows = await db
    .select({
      bottleId: pours.bottleId,
      flavorTags: tastingNotes.flavorTags,
      nose: tastingNotes.nose,
      palate: tastingNotes.palate,
      finish: tastingNotes.finish,
    })
    .from(tastingNotes)
    .innerJoin(pours, eq(tastingNotes.pourId, pours.id))
    .innerJoin(bottles, eq(pours.bottleId, bottles.id))
    .where(isNull(bottles.flavorProfile))
    .orderBy(tastingNotes.createdAt);
  const notesByBottle = new Map<string, NoteContext[]>();
  for (const row of noteRows) {
    const list = notesByBottle.get(row.bottleId) ?? [];
    list.unshift(row); // newest first
    notesByBottle.set(row.bottleId, list);
  }

  const writeProfile = async (id: string, profile: Record<string, number>): Promise<void> => {
    if (report.dryRun) return;
    await db
      .update(bottles)
      .set({ flavorProfile: profile })
      .where(and(eq(bottles.id, id), isNull(bottles.flavorProfile)));
  };

  // Tier 1: community-note roll-ups; leftovers go to the model.
  const aiTargets: EnrichableBottle[] = [];
  for (const target of targets) {
    const notes = notesByBottle.get(target.id) ?? [];
    const fromNotes = profileFromNotes(notes);
    if (fromNotes) {
      report.fromNotes += 1;
      await writeProfile(target.id, fromNotes);
      continue;
    }
    aiTargets.push({
      ...target,
      userNotes: notes
        .map(noteSnippet)
        .filter((s): s is string => s !== null)
        .slice(0, 3),
    });
  }

  if (aiTargets.length === 0) return report;
  const anthropic = opts.client ?? getAnthropic();
  const model = enrichModel(web);

  for (let i = 0; i < aiTargets.length; i += batchSize) {
    const batch = aiTargets.slice(i, i + batchSize);
    report.batches += 1;
    const text = await runModelBatch(anthropic, model, batch, web);

    const parsed = parseModelJson(text);
    // Accept a bare entry object too — defensive parsing can land on the
    // first {...} span when the model wraps the array in prose.
    const entries = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
    const batchIds = new Set(batch.map((b) => b.id));
    const seen = new Set<string>();

    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, profile } = entry as { id?: unknown; profile?: unknown };
      if (typeof id !== "string" || !batchIds.has(id) || seen.has(id)) continue;
      const clean = cleanProfile(profile);
      if (!clean) continue;
      seen.add(id);
      report.fromAi += 1;
      await writeProfile(id, clean);
    }
    report.rejected += batch.length - seen.size;
    opts.onBatch?.(report.batches, report.fromNotes + report.fromAi);
  }

  return report;
}

/**
 * One model call for a batch, with the web search tool when enabled. Server
 * tools run in a server-side loop that can pause (stop_reason "pause_turn");
 * resume by re-sending the assistant turn, and concatenate the text across
 * continuations.
 */
async function runModelBatch(
  anthropic: Anthropic,
  model: string,
  batch: EnrichableBottle[],
  web: boolean,
): Promise<string> {
  const prompt = buildEnrichPrompt(batch, web);
  const base = {
    model,
    max_tokens: 8000,
    ...(web
      ? {
          tools: [
            { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: batch.length },
          ],
        }
      : {}),
  };

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: prompt },
  ];
  const texts: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await anthropic.messages.create({
      ...base,
      messages,
    } as never);
    texts.push(textFromContent(response.content as never));
    if (response.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: response.content });
  }
  return texts.join("\n");
}
