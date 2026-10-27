import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, distilleries, enrichmentRuns } from "@/db/schema";
import { buildEnrichPrompt, type EnrichableBottle } from "@/lib/ingest/enrich";
import { parseModelResults, runFreePass, writeTieredProfiles } from "@/lib/ingest/flavor-tiers";
import { LEGACY_REFRESH_SAFE, POPULAR_REFRESH_TOP, popularitySql } from "@/lib/popularity";
import { canSpend, getSettings, recordCall, releaseReservation, reserveSpend, updateSettings } from "./budget";
import { getEnrichProvider, ProviderCallError } from "./providers";
import { dueJobIds, requeueBottle, runJobToCompletion, STEP_HEADROOM_MS } from "./queue";
import { withDbBudget } from "@/db/resilient-client";

/**
 * Scheduled / operator-started enrichment in bounded chunks
 * (docs/DATA_SOURCES.md §2.4c). One chunk fits one function invocation; the
 * daily cron chains a few chunks, the admin page runs one per click.
 *
 * Tiers, cheapest first:
 *   queue   — live jobs nobody was watching (finish them)
 *   keyword — the free pass over new/changed catalog text (no model)
 *   missing — bottles with no profile, 25 per quick-model call; resumes from
 *             `enrichment_settings.missing_cursor`, so a bottle the model
 *             keeps failing on is passed over rather than retried forever
 *   web     — the most popular / most searched bottles (src/lib/popularity.ts)
 *             still below `model_web` — including untracked legacy profiles
 *             inside the top POPULAR_REFRESH_TOP — one web call each, as
 *             `refresh` jobs (so they're visible and retryable)
 *
 * Every selection is "what still needs it", so re-running is idempotent and
 * a stopped chunk resumes where it left off. Every model call passes the
 * budget gate first; the tier guard keeps every write below higher tiers.
 */

export const BATCH_TIERS = ["queue", "keyword", "missing", "web"] as const;
export type BatchTier = (typeof BATCH_TIERS)[number];
export const MISSING_BATCH_SIZE = 25;
export const MISSING_TIMEOUT_MS = 40_000;
/** Work time for one chunk inside a 60 s function (leaves room to record the run and answer). */
export const CHUNK_MS = 55_000;
/** How long the web tier waits before refreshing the same bottle again. */
export const WEB_REFRESH_AFTER_DAYS = 30;

export interface BatchResult {
  runId: string;
  counts: Record<string, number>;
  stopReason: "done" | "deadline" | "budget" | "paused" | "disabled";
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as T[];
}

export async function runBatch(
  db: DB,
  opts: { trigger: "cron" | "admin"; tiers: BatchTier[]; budgetMs: number },
): Promise<BatchResult> {
  // Catalog-wide scans (the free pass) may legitimately run longer than the
  // request watchdog in src/db/resilient-client.ts; give them the chunk budget.
  return withDbBudget(Math.max(opts.budgetMs, 60_000), () => runBatchInner(db, opts));
}

async function runBatchInner(
  db: DB,
  opts: { trigger: "cron" | "admin"; tiers: BatchTier[]; budgetMs: number },
): Promise<BatchResult> {
  const deadline = Date.now() + opts.budgetMs;
  const runId = crypto.randomUUID();
  await db.insert(enrichmentRuns).values({ id: runId, trigger: opts.trigger, tiers: opts.tiers, state: "running" });
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
  let stopReason: BatchResult["stopReason"] = "done";
  const timeLeft = () => deadline - Date.now();
  try {
    for (const tier of BATCH_TIERS) {
      if (!opts.tiers.includes(tier)) continue;
      if (timeLeft() < 5_000) {
        stopReason = "deadline";
        break;
      }
      if (tier === "queue") {
        for (const id of await dueJobIds(db, 20)) {
          if (timeLeft() < STEP_HEADROOM_MS) {
            stopReason = "deadline";
            break;
          }
          bump("queueSteps", await runJobToCompletion(db, id, deadline, runId));
        }
      } else if (tier === "keyword") {
        const report = await runFreePass(db);
        bump("keywordWritten", report.written);
      } else if (tier === "missing") {
        const r = await missingTier(db, runId, deadline, bump);
        if (r !== "done") {
          stopReason = r;
          if (r !== "deadline") break;
        }
      } else if (tier === "web") {
        const r = await webTier(db, runId, deadline, bump);
        if (r !== "done") stopReason = r;
      }
      if (stopReason === "deadline") break;
    }
    await db
      .update(enrichmentRuns)
      .set({ state: stopReason === "done" ? "done" : "stopped", counts, stopReason, finishedAt: new Date() })
      .where(eq(enrichmentRuns.id, runId));
  } catch (err) {
    await db
      .update(enrichmentRuns)
      .set({ state: "failed", counts, error: err instanceof Error ? err.message.slice(0, 300) : String(err), finishedAt: new Date() })
      .where(eq(enrichmentRuns.id, runId));
    throw err;
  }
  return { runId, counts, stopReason };
}

type Stop = "done" | "deadline" | "budget" | "paused" | "disabled";

async function missingTier(db: DB, runId: string, deadline: number, bump: (k: string, n?: number) => void): Promise<Stop> {
  let wrapped = false;
  for (;;) {
    if (deadline - Date.now() < MISSING_TIMEOUT_MS + 2_000) return "deadline";
    const gate = await canSpend(db, "batch-quick");
    if (!gate.ok) return gate.reason;
    const provider = getEnrichProvider();
    if (!provider) return "disabled";
    const { missingCursor } = await getSettings(db);
    const rows = await db
      .select({
        id: bottles.id,
        name: bottles.name,
        category: bottles.category,
        distillery: distilleries.name,
        region: bottles.region,
        country: bottles.country,
        abv: bottles.abv,
        ageYears: bottles.ageYears,
        description: bottles.description,
      })
      .from(bottles)
      .leftJoin(distilleries, eq(distilleries.id, bottles.distilleryId))
      .where(and(isNull(bottles.flavorProfile), missingCursor ? gt(bottles.id, missingCursor) : undefined))
      .orderBy(asc(bottles.id))
      .limit(MISSING_BATCH_SIZE);
    if (rows.length === 0) {
      if (!missingCursor || wrapped) return "done";
      // Back to the start once: bottles passed over earlier get another go.
      await updateSettings(db, { missingCursor: null });
      wrapped = true;
      continue;
    }
    const batch: EnrichableBottle[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      distillery: r.distillery,
      region: r.region ?? r.country,
      abv: r.abv,
      ageYears: r.ageYears,
      description: r.description?.slice(0, 600) ?? null,
      userNotes: [],
    }));
    const model = provider.quickModel;
    const hold = await reserveSpend(db, "batch-quick");
    if (!hold.ok) return hold.reason;
    const started = Date.now();
    try {
      const res = await provider.complete({
        prompt: buildEnrichPrompt(batch, false),
        model,
        web: false,
        timeoutMs: MISSING_TIMEOUT_MS,
        maxOutputTokens: 4_000,
      });
      await recordCall(db, { runId, step: "batch-quick", provider: provider.name, model, bottles: batch.length, usage: res.usage, ok: true, latencyMs: Date.now() - started });
      const { writes, rejected } = parseModelResults([
        { pass: "cheap", model, bottleIds: batch.map((b) => b.id), raw: res.text, completedAt: new Date().toISOString() },
      ]);
      const written = await writeTieredProfiles(db, writes.map((w) => ({ ...w, method: `enrich:${model}` })));
      bump("missingWritten", written.length);
      bump("missingRejected", rejected);
    } catch (err) {
      await recordCall(db, {
        runId,
        step: "batch-quick",
        provider: provider.name,
        model,
        bottles: batch.length,
        usage: err instanceof ProviderCallError ? err.usage : null,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      });
      bump("missingFailedCalls");
    } finally {
      await releaseReservation(db, hold.reservationId);
    }
    await updateSettings(db, { missingCursor: rows[rows.length - 1].id });
  }
}

async function webTier(db: DB, runId: string, deadline: number, bump: (k: string, n?: number) => void): Promise<Stop> {
  for (;;) {
    if (deadline - Date.now() < STEP_HEADROOM_MS) return "deadline";
    const gate = await canSpend(db, "batch-web");
    if (!gate.ok) return gate.reason;
    const [candidate] = rowsOf<{ id: string }>(
      await db.execute(sql`
        WITH pop AS (${popularitySql()}),
        top AS (
          SELECT pop.bottle_id, pop.popularity FROM pop JOIN bottles b ON b.id = pop.bottle_id
          WHERE b.status <> 'user_submitted'
          ORDER BY pop.popularity DESC, pop.bottle_id LIMIT ${POPULAR_REFRESH_TOP}
        )
        SELECT b.id FROM top
        JOIN bottles b ON b.id = top.bottle_id
        LEFT JOIN bottle_flavor_provenance p ON p.bottle_id = b.id
        LEFT JOIN bottle_enrichment_jobs j ON j.bottle_id = b.id
        WHERE (b.flavor_profile IS NULL OR p.tier IN ('keyword', 'model')
               OR (p.bottle_id IS NULL AND ${LEGACY_REFRESH_SAFE}))
          AND (j.id IS NULL OR (j.state IN ('done', 'failed')
               AND j.finished_at < now() - make_interval(days => ${WEB_REFRESH_AFTER_DAYS}::int)))
        ORDER BY top.popularity DESC, b.id
        LIMIT 1`),
    );
    if (!candidate) return "done";
    const jobId = await requeueBottle(db, candidate.id, "refresh", ["web"]);
    bump("webSteps", await runJobToCompletion(db, jobId, deadline, runId));
  }
}

export async function recentRuns(db: DB, limit = 15) {
  return db.select().from(enrichmentRuns).orderBy(desc(enrichmentRuns.startedAt)).limit(limit);
}
