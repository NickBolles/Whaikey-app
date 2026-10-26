import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import {
  bottleEnrichmentEvents,
  bottleEnrichmentJobs,
  bottles,
  criticNotes,
  distilleries,
  bottleSubmissions,
  type BottleEnrichmentJob,
  type EnrichmentResult,
  type EnrichmentStep,
  type FlavorProfileTier,
} from "@/db/schema";
import { catalogVisibleTo } from "@/lib/catalog-visibility";
import { keywordInputHash, keywordProfile, TIER_CONFIDENCE, writeTieredProfiles, type KeywordInputs } from "@/lib/ingest/flavor-tiers";
import { reportInBackground } from "@/lib/observability/errors";
import { canSpend, recordCall } from "./budget";
import { quickPrompt, webPrompt, type PromptBottle } from "./prompts";
import { enrichLive, getEnrichProvider, ProviderCallError } from "./providers";
import { parseQuickResult, parseWebResult, profileHeadline, type WebDetails } from "./validate";

/**
 * In-app enrichment for bottles (docs/DATA_SOURCES.md §2.4b).
 *
 * Adding a bottle writes a job; a Vercel function runs it ONE STEP PER
 * INVOCATION — keyword (free) → quick model profile → web model notes — so no
 * invocation needs more than one model call inside Hobby's 60 s. The first
 * step is kicked from the create request's `after()`; every later step is
 * kicked by the bottle page's own poll (`/api/bottles/:id/enrichment`, also
 * via `after()`), and the daily cron drains whatever nobody was watching.
 * A lease makes concurrent kicks harmless: only one invocation runs a step.
 *
 * The server owns every decision that matters: the provider gate (ENRICH_ENABLED,
 * pause, daily $ cap — src/lib/enrich/budget.ts), validation, the tier guard
 * on profile writes (`writeTieredProfiles`: never over a higher tier, a legacy
 * profile or community notes), filling only empty columns, and the copy users
 * read. User notes are never sent to a model.
 */

/** Longer than any function's maxDuration, so a killed step's lease lapses and the next kick retries it. */
export const ENRICH_LEASE_MS = 90_000;
export const ENRICH_MAX_ATTEMPTS = 3;
/** Live jobs per submitter; beyond this the daily batch covers the bottle. */
export const ENRICH_LIMIT_PER_HOUR = 10;
export const ENRICH_LIMIT_PER_DAY = 30;
/** How long a job parks when the budget or a pause stops it. */
export const ENRICH_PARKED_BACKOFF_MS = 10 * 60_000;
/** A queued job nobody has started for this long reads "we'll finish this soon". */
export const ENRICH_STALE_QUEUE_MS = 45_000;
/** Per-step model budgets, inside a 60 s function. */
export const QUICK_TIMEOUT_MS = 20_000;
export const WEB_TIMEOUT_MS = 50_000;

export type EnrichmentReason = "new_bottle" | "scan" | "import" | "refresh" | "admin";
/** Reasons whose progress is shown live on the bottle page. */
export const LIVE_REASONS: ReadonlySet<string> = new Set(["new_bottle", "scan", "import", "admin"]);

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as T[];
}

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventKind = "queued" | "claimed" | "step_started" | "step_done" | "found" | "waiting" | "done" | "failed";

export async function appendEvent(
  db: DB,
  jobId: string,
  event: { kind: EventKind; step?: EnrichmentStep | null; message: string; data?: Record<string, unknown> | null },
): Promise<number> {
  // The per-job counter is bumped and read in one statement, so concurrent
  // appends get distinct seq numbers (the unique index backs it up).
  const [row] = await db
    .update(bottleEnrichmentJobs)
    .set({ lastSeq: sql`${bottleEnrichmentJobs.lastSeq} + 1` })
    .where(eq(bottleEnrichmentJobs.id, jobId))
    .returning({ seq: bottleEnrichmentJobs.lastSeq });
  if (!row) throw new Error(`no job ${jobId}`);
  await db.insert(bottleEnrichmentEvents).values({
    id: crypto.randomUUID(),
    jobId,
    seq: row.seq,
    kind: event.kind,
    step: event.step ?? null,
    message: event.message,
    data: event.data ?? null,
  });
  return row.seq;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Queue a just-added bottle. Returns the job id, or null when enrichment is
 * not switched on (inert until configured), the submitter is over the live
 * limit (the daily batch still covers the bottle), or a job already exists.
 */
export async function enqueueEnrichment(
  db: DB,
  input: { bottleId: string; submittedBy: string; reason: EnrichmentReason },
  now = new Date(),
): Promise<string | null> {
  if (!enrichLive()) return null;
  const [counts] = rowsOf<{ hour: number; day: number }>(
    await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE j.created_at > ${ts(new Date(now.getTime() - 3_600_000))})::int AS hour,
             COUNT(*)::int AS day
      FROM bottle_enrichment_jobs j JOIN bottles b ON b.id = j.bottle_id
      WHERE b.submitted_by = ${input.submittedBy} AND j.created_at > ${ts(new Date(now.getTime() - 86_400_000))}`),
  );
  if (Number(counts?.hour ?? 0) >= ENRICH_LIMIT_PER_HOUR || Number(counts?.day ?? 0) >= ENRICH_LIMIT_PER_DAY) return null;

  const jobId = crypto.randomUUID();
  const [row] = await db
    .insert(bottleEnrichmentJobs)
    .values({ id: jobId, bottleId: input.bottleId, reason: input.reason, notBefore: now })
    .onConflictDoNothing()
    .returning({ id: bottleEnrichmentJobs.id });
  if (!row) return null;
  await appendEvent(db, jobId, { kind: "queued", message: "Queued — checking sources shortly" });
  return jobId;
}

/**
 * (Re)open a job for a bottle regardless of who added it — the operator's
 * per-bottle re-enrich and the batch's web tier. `steps` limits what runs
 * (a refresh of a catalog bottle only needs the web step).
 */
export async function requeueBottle(
  db: DB,
  bottleId: string,
  reason: EnrichmentReason,
  steps: EnrichmentStep[] = ["keyword", "quick", "web"],
  now = new Date(),
): Promise<string> {
  const skip = (["keyword", "quick", "web"] as EnrichmentStep[]).filter((s) => !steps.includes(s));
  const [row] = await db
    .insert(bottleEnrichmentJobs)
    .values({ id: crypto.randomUUID(), bottleId, reason, notBefore: now, stepsDone: skip })
    .onConflictDoUpdate({
      target: bottleEnrichmentJobs.bottleId,
      set: {
        reason,
        state: "queued",
        stepsDone: skip,
        attempts: 0,
        waitingReason: null,
        leaseExpiresAt: null,
        notBefore: now,
        error: null,
        finishedAt: null,
        claimedAt: null,
        createdAt: now,
      },
    })
    .returning({ id: bottleEnrichmentJobs.id });
  await appendEvent(db, row.id, { kind: "queued", message: "Queued — checking sources shortly" });
  return row.id;
}

/** Failed jobs back to the queue (operator "retry failures"). */
export async function retryFailedJobs(db: DB, now = new Date()): Promise<number> {
  const rows = await db
    .update(bottleEnrichmentJobs)
    .set({ state: "queued", attempts: 0, error: null, finishedAt: null, waitingReason: null, notBefore: now, leaseExpiresAt: null })
    .where(eq(bottleEnrichmentJobs.state, "failed"))
    .returning({ id: bottleEnrichmentJobs.id });
  for (const r of rows) await appendEvent(db, r.id, { kind: "queued", message: "Queued — trying again" });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Running a job, one step per call
// ---------------------------------------------------------------------------

async function promptBottle(db: DB, bottleId: string): Promise<PromptBottle | null> {
  const [row] = await db
    .select({
      id: bottles.id,
      name: bottles.name,
      category: bottles.category,
      distillery: sql<string | null>`coalesce(${distilleries.name}, ${bottleSubmissions.distilleryText})`,
      country: bottles.country,
      region: bottles.region,
      abv: bottles.abv,
      ageYears: bottles.ageYears,
      description: bottles.description,
    })
    .from(bottles)
    .leftJoin(distilleries, eq(distilleries.id, bottles.distilleryId))
    .leftJoin(bottleSubmissions, eq(bottleSubmissions.bottleId, bottles.id))
    .where(eq(bottles.id, bottleId))
    .limit(1);
  return row ?? null;
}

/**
 * Lease up to `max` claimable jobs: queued and due, or running with a lapsed
 * lease. One running job per submitter at a time, so one person adding twenty
 * bottles can't hold up everyone else's first one.

const STEP_STARTED: Record<EnrichmentStep, string> = {
  keyword: "Reading what's already on file",
  quick: "Sketching a quick flavor profile",
  web: "Searching the web for published tasting notes",
};

const STEP_ORDER: EnrichmentStep[] = ["keyword", "quick", "web"];

/** Lease the job if it is due (queued) or abandoned (running, lease lapsed). */
async function lease(db: DB, jobId: string, now: Date): Promise<BottleEnrichmentJob | null> {
  const [job] = await db
    .update(bottleEnrichmentJobs)
    .set({
      state: "running",
      // A lapsed lease means the last invocation died mid-step: that counts.
      attempts: sql`CASE WHEN ${bottleEnrichmentJobs.state} = 'running' THEN ${bottleEnrichmentJobs.attempts} + 1 ELSE ${bottleEnrichmentJobs.attempts} END`,
      leaseExpiresAt: new Date(now.getTime() + ENRICH_LEASE_MS),
      claimedAt: sql`coalesce(${bottleEnrichmentJobs.claimedAt}, ${ts(now)})`,
    })
    .where(
      and(
        eq(bottleEnrichmentJobs.id, jobId),
        sql`((${bottleEnrichmentJobs.state} = 'queued' AND ${bottleEnrichmentJobs.notBefore} <= ${ts(now)})
          OR (${bottleEnrichmentJobs.state} = 'running' AND ${bottleEnrichmentJobs.leaseExpiresAt} < ${ts(now)}))`,
      ),
    )
    .returning();
  return job ?? null;
}

/** Put a leased job back in the queue (due now, or parked). */
async function unlease(db: DB, jobId: string, patch: Partial<typeof bottleEnrichmentJobs.$inferInsert> = {}): Promise<void> {
  await db
    .update(bottleEnrichmentJobs)
    .set({ state: "queued", leaseExpiresAt: null, ...patch })
    .where(eq(bottleEnrichmentJobs.id, jobId));
}

async function finish(db: DB, job: BottleEnrichmentJob, now: Date): Promise<void> {
  await db
    .update(bottleEnrichmentJobs)
    .set({ state: "done", finishedAt: now, leaseExpiresAt: null, waitingReason: null })
    .where(eq(bottleEnrichmentJobs.id, job.id));
  await appendEvent(db, job.id, { kind: "done", message: "Card complete" });
}

async function fail(db: DB, job: BottleEnrichmentJob, now: Date, error: string): Promise<void> {
  await db
    .update(bottleEnrichmentJobs)
    .set({ state: "failed", finishedAt: now, leaseExpiresAt: null, error: error.slice(0, 300) })
    .where(eq(bottleEnrichmentJobs.id, job.id));
  await appendEvent(db, job.id, { kind: "failed", message: "Couldn't finish this one — the daily catalog pass will pick it up" });
}

const PARKED_COPY: Record<string, string> = {
  budget: "Queued — we'll finish this soon",
  paused: "Queued — we'll finish this soon",
  disabled: "Queued — we'll finish this soon",
};

export type StepRunResult =
  | { ran: EnrichmentStep; next: EnrichmentStep | null }
  | { ran: null; reason: "not-due" | "parked" | "failed" | "done" };

/**
 * Run the job's next step, if it is due and nobody else holds it. Keyword is
 * free and is followed by the quick step in the same call; the web step is
 * always its own call. Never throws for a model failure: those back off and
 * give up after ENRICH_MAX_ATTEMPTS.
 */
export async function runNextStep(db: DB, jobId: string, opts: { runId?: string | null; now?: Date } = {}): Promise<StepRunResult> {
  const now = opts.now ?? new Date();
  const job = await lease(db, jobId, now);
  if (!job) return { ran: null, reason: "not-due" };
  if (job.attempts >= ENRICH_MAX_ATTEMPTS) {
    await fail(db, job, now, "gave up after repeated failures");
    return { ran: null, reason: "failed" };
  }
  try {
    let step = STEP_ORDER.find((s) => !job.stepsDone.includes(s)) ?? null;
    if (!step) {
      await finish(db, job, now);
      return { ran: null, reason: "done" };
    }
    if (job.stepsDone.length === 0 && job.attempts === 0 && job.lastSeq <= 1) {
      await appendEvent(db, job.id, { kind: "claimed", message: "Checking sources…" });
    }
    if (step === "keyword") {
      await appendEvent(db, job.id, { kind: "step_started", step, message: STEP_STARTED.keyword });
      await runKeywordStep(db, job);
      step = STEP_ORDER.find((s) => !job.stepsDone.includes(s)) ?? null;
      if (!step) {
        await finish(db, job, now);
        return { ran: "keyword", next: null };
      }
    }
    const gate = await canSpend(db, step === "quick" ? "quick" : "web", now);
    if (!gate.ok) {
      await unlease(db, job.id, { waitingReason: gate.reason, notBefore: new Date(now.getTime() + ENRICH_PARKED_BACKOFF_MS) });
      if (job.waitingReason !== gate.reason) {
        await appendEvent(db, job.id, { kind: "waiting", message: PARKED_COPY[gate.reason], data: { reason: gate.reason } });
      }
      return { ran: null, reason: "parked" };
    }
    await appendEvent(db, job.id, { kind: "step_started", step, message: STEP_STARTED[step] });
    const ok = await runModelStep(db, job, step, opts.runId ?? null);
    if (!ok) {
      const attempts = job.attempts + 1;
      if (attempts >= ENRICH_MAX_ATTEMPTS) {
        await fail(db, job, new Date(), "model step failed");
        return { ran: null, reason: "failed" };
      }
      await unlease(db, job.id, { attempts, waitingReason: "error", notBefore: new Date(Date.now() + 30_000 * attempts) });
      await appendEvent(db, job.id, { kind: "waiting", message: "Hit a snag — retrying shortly", data: { reason: "error" } });
      return { ran: null, reason: "parked" };
    }
    const next = STEP_ORDER.find((s) => !job.stepsDone.includes(s)) ?? null;
    if (!next) {
      await finish(db, job, new Date());
      return { ran: step, next: null };
    }
    await unlease(db, job.id, { waitingReason: null, notBefore: new Date() });
    return { ran: step, next };
  } catch (err) {
    // Anything unexpected: hand the job back so the next kick can retry.
    reportInBackground(err, { where: "enrich/run-step", tags: { jobId } });
    await unlease(db, job.id, { attempts: job.attempts + 1, notBefore: new Date(Date.now() + 30_000) }).catch(() => {});
    return { ran: null, reason: "parked" };
  }
}

/** Run up to `maxSteps` steps back to back while time allows (cron/admin drain). */
export async function runJobToCompletion(db: DB, jobId: string, deadline: number, runId: string | null = null): Promise<number> {
  let steps = 0;
  while (Date.now() + WEB_TIMEOUT_MS + 5_000 < deadline) {
    const r = await runNextStep(db, jobId, { runId });
    if (!r.ran) break;
    steps += 1;
    if (!r.next) break;
  }
  return steps;
}

/** Jobs that can run now, oldest first. */
export async function dueJobIds(db: DB, limit: number, now = new Date()): Promise<string[]> {
  const rows = await db
    .select({ id: bottleEnrichmentJobs.id })
    .from(bottleEnrichmentJobs)
    .where(
      sql`(${bottleEnrichmentJobs.state} = 'queued' AND ${bottleEnrichmentJobs.notBefore} <= ${ts(now)})
        OR (${bottleEnrichmentJobs.state} = 'running' AND ${bottleEnrichmentJobs.leaseExpiresAt} < ${ts(now)})`,
    )
    .orderBy(asc(bottleEnrichmentJobs.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Bottle id → whether its job is due, for the poll route's decision to kick. */
export async function jobIsDue(db: DB, bottleId: string, now = new Date()): Promise<string | null> {
  const [row] = await db
    .select({ id: bottleEnrichmentJobs.id })
    .from(bottleEnrichmentJobs)
    .where(
      and(
        eq(bottleEnrichmentJobs.bottleId, bottleId),
        sql`((${bottleEnrichmentJobs.state} = 'queued' AND ${bottleEnrichmentJobs.notBefore} <= ${ts(now)})
          OR (${bottleEnrichmentJobs.state} = 'running' AND ${bottleEnrichmentJobs.leaseExpiresAt} < ${ts(now)}))`,
      ),
    );
  return row?.id ?? null;
}

async function runModelStep(db: DB, job: BottleEnrichmentJob, step: "quick" | "web", runId: string | null): Promise<boolean> {
  const provider = getEnrichProvider();
  const bottle = await promptBottle(db, job.bottleId);
  if (!provider || !bottle) return false;
  const model = step === "quick" ? provider.quickModel : provider.webModel;
  const started = Date.now();
  let text: string;
  try {
    const res = await provider.complete({
      prompt: step === "quick" ? quickPrompt(bottle) : webPrompt(bottle),
      model,
      web: step === "web",
      timeoutMs: step === "quick" ? QUICK_TIMEOUT_MS : WEB_TIMEOUT_MS,
      maxOutputTokens: step === "quick" ? 1_500 : 4_000,
      maxSearches: 3,
    });
    text = res.text;
    await recordCall(db, { jobId: job.id, runId, step, provider: provider.name, model, usage: res.usage, ok: true, latencyMs: Date.now() - started });
  } catch (err) {
    await recordCall(db, {
      jobId: job.id,
      runId,
      step,
      provider: provider.name,
      model,
      usage: err instanceof ProviderCallError ? err.usage : null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    });
    return false;
  }
  if (step === "quick") await applyQuick(db, job, model, text);
  else await applyWeb(db, job, model, text);
  return true;
}

async function applyQuick(db: DB, job: BottleEnrichmentJob, model: string, raw: string): Promise<void> {
  const profile = parseQuickResult(raw, job.bottleId);
  const written = profile ? await writeProfile(db, job.bottleId, profile, "model", model) : false;
  await markStepDone(db, job, "quick");
  if (profile && written) {
    await appendEvent(db, job.id, {
      kind: "found",
      step: "quick",
      message: `Found a flavor profile — ${profileHeadline(profile).toLowerCase()}`,
      data: { field: "profile", profile, tier: "model" },
    });
  }
  await appendEvent(db, job.id, {
    kind: "step_done",
    step: "quick",
    message: profile ? (written ? "Flavor profile sketched" : "Kept the profile we already had") : "Quick profile came back unusable",
  });
}

async function applyWeb(db: DB, job: BottleEnrichmentJob, model: string, raw: string): Promise<void> {
  const result = parseWebResult(raw);
  const stored: EnrichmentResult = { ...(job.result ?? {}) };
  if (result) {
    const sourced = result.sources.length > 0;
    if (result.profile) {
      // Without a cited source a "web" answer is the model's own knowledge:
      // recorded at the quick tier, not as web-grounded.
      const tier: FlavorProfileTier = sourced ? "model_web" : "model";
      if (await writeProfile(db, job.bottleId, result.profile, tier, model)) {
        stored.profileTier = tier;
        await appendEvent(db, job.id, {
          kind: "found",
          step: "web",
          message: `Refined the flavor profile — ${profileHeadline(result.profile).toLowerCase()}`,
          data: { field: "profile", profile: result.profile, tier },
        });
      }
    }
    if (result.notes) {
      stored.notes = result.notes;
      stored.sources = result.sources;
      await appendEvent(db, job.id, {
        kind: "found",
        step: "web",
        message: "Found tasting notes",
        data: { field: "notes", notes: result.notes, sources: result.sources },
      });
    }
    const filled = await fillEmptyDetails(db, job.bottleId, result.details);
    if (filled.length > 0) {
      stored.filled = [...new Set([...(stored.filled ?? []), ...filled.map((f) => f.field)])];
      stored.sources = result.sources;
      await appendEvent(db, job.id, {
        kind: "found",
        step: "web",
        message: `Found details — ${filled.map((f) => f.label).join(" · ")}`,
        data: { field: "details", details: Object.fromEntries(filled.map((f) => [f.field, f.value])) },
      });
    }
  }
  await markStepDone(db, job, "web", stored);
  const n = result?.sources.length ?? 0;
  await appendEvent(db, job.id, {
    kind: "step_done",
    step: "web",
    message: n > 0 ? `Checked ${n} source${n === 1 ? "" : "s"}` : "No published notes found for this bottling",
    data: { sources: n },
  });
}

async function markStepDone(db: DB, job: BottleEnrichmentJob, step: EnrichmentStep, result?: EnrichmentResult): Promise<void> {
  const steps = job.stepsDone.includes(step) ? job.stepsDone : [...job.stepsDone, step];
  await db
    .update(bottleEnrichmentJobs)
    .set({ stepsDone: steps, ...(result ? { result } : {}) })
    .where(eq(bottleEnrichmentJobs.id, job.id));
  job.stepsDone = steps;
  if (result) job.result = result;
}

async function writeProfile(
  db: DB,
  bottleId: string,
  profile: Record<string, number>,
  tier: FlavorProfileTier,
  model: string | null,
  inputHash: string | null = null,
): Promise<boolean> {
  const pass = tier === "keyword" ? "free" : tier === "model" ? "cheap" : "heavy";
  const written = await writeTieredProfiles(db, [
    {
      bottleId,
      profile,
      tier,
      confidence: TIER_CONFIDENCE[tier],
      method: model ? `enrich:${model}` : "enrich:keyword-matcher",
      model,
      pass,
      inputHash,
    },
  ]);
  return written.length > 0;
}

/** Free step, computed here from what the catalog already holds. */
export async function runKeywordStep(db: DB, job: BottleEnrichmentJob): Promise<{ profile: Record<string, number> | null }> {
  const [bottle] = await db
    .select({ description: bottles.description, producerFlavorTags: bottles.producerFlavorTags })
    .from(bottles)
    .where(eq(bottles.id, job.bottleId));
  const critics = await db
    .select({ note: criticNotes.note, flavorTags: criticNotes.flavorTags })
    .from(criticNotes)
    .where(eq(criticNotes.bottleId, job.bottleId));
  const inputs: KeywordInputs = {
    description: bottle?.description ?? null,
    producerFlavorTags: bottle?.producerFlavorTags ?? null,
    criticNotes: critics.map((c) => ({ note: c.note, flavorTags: c.flavorTags })),
    userNotes: [],
  };
  const profile = keywordProfile(inputs);
  const written = profile ? await writeProfile(db, job.bottleId, profile, "keyword", null, keywordInputHash(inputs)) : false;
  await markStepDone(db, job, "keyword");
  if (profile && written) {
    await appendEvent(db, job.id, {
      kind: "found",
      step: "keyword",
      message: `Found a starting profile on file — ${profileHeadline(profile).toLowerCase()}`,
      data: { field: "profile", profile, tier: "keyword" },
    });
  }
  await appendEvent(db, job.id, {
    kind: "step_done",
    step: "keyword",
    message: profile ? "Read the catalog's notes" : "Nothing on file yet",
  });
  return { profile: written ? profile : null };
}

/** Write details into columns that are still empty. User-entered values are never replaced. */
async function fillEmptyDetails(
  db: DB,
  bottleId: string,
  details: WebDetails,
): Promise<Array<{ field: keyof WebDetails; value: unknown; label: string }>> {
  const [current] = await db
    .select({ abv: bottles.abv, ageYears: bottles.ageYears, caskTypes: bottles.caskTypes, mashBill: bottles.mashBill, country: bottles.country })
    .from(bottles)
    .where(eq(bottles.id, bottleId));
  if (!current) return [];
  const filled: Array<{ field: keyof WebDetails; value: unknown; label: string }> = [];
  const set: Partial<typeof bottles.$inferInsert> = {};
  if (details.abv != null && current.abv == null) {
    set.abv = details.abv;
    filled.push({ field: "abv", value: details.abv, label: `${details.abv}% ABV` });
  }
  if (details.ageYears != null && current.ageYears == null) {
    set.ageYears = details.ageYears;
    filled.push({ field: "ageYears", value: details.ageYears, label: `${details.ageYears} years` });
  }
  if (details.caskTypes && (current.caskTypes == null || current.caskTypes.length === 0)) {
    set.caskTypes = details.caskTypes;
    filled.push({ field: "caskTypes", value: details.caskTypes, label: details.caskTypes.join(" + ") });
  }
  if (details.mashBill && current.mashBill == null) {
    set.mashBill = details.mashBill;
    filled.push({ field: "mashBill", value: details.mashBill, label: details.mashBill });
  }
  if (details.country && current.country == null) {
    set.country = details.country;
    filled.push({ field: "country", value: details.country, label: details.country });
  }
  if (filled.length === 0) return [];
  // Guarded per column in SQL as well, so a value set since the read above wins.
  await db
    .update(bottles)
    .set({
      ...(set.abv != null ? { abv: sql`coalesce(${bottles.abv}, ${set.abv})` } : {}),
      ...(set.ageYears != null ? { ageYears: sql`coalesce(${bottles.ageYears}, ${set.ageYears})` } : {}),
      ...(set.caskTypes ? { caskTypes: sql`coalesce(${bottles.caskTypes}, ${JSON.stringify(set.caskTypes)}::jsonb)` } : {}),
      ...(set.mashBill ? { mashBill: sql`coalesce(${bottles.mashBill}, ${set.mashBill})` } : {}),
      ...(set.country ? { country: sql`coalesce(${bottles.country}, ${set.country})` } : {}),
    })
    .where(eq(bottles.id, bottleId));
  return filled;
}


export interface EnrichmentView {
  job: {
    reason: string;
    state: "queued" | "running" | "done" | "failed";
    stepsDone: EnrichmentStep[];
    /** "budget" | "paused" | "disabled" | "error" | "stale" (queued and unclaimed for a while) | null */
    waiting: string | null;
    createdAt: string;
    claimedAt: string | null;
    finishedAt: string | null;
    lastSeq: number;
  } | null;
  events: Array<{ seq: number; kind: string; step: string | null; message: string; data: Record<string, unknown> | null; at: string }>;
  fields: {
    profile: Record<string, number> | null;
    abv: number | null;
    ageYears: number | null;
    caskTypes: string[] | null;
    mashBill: string | null;
    country: string | null;
    notes: EnrichmentResult["notes"] | null;
    sources: EnrichmentResult["sources"] | null;
  };
}

/** What the bottle page polls. Null when the viewer can't see the bottle (a 404, as everywhere else). */
export async function getEnrichmentView(
  db: DB,
  bottleId: string,
  viewerId: string | undefined,
  afterSeq = 0,
  now = new Date(),
): Promise<EnrichmentView | null> {
  const [row] = await db
    .select({
      flavorProfile: bottles.flavorProfile,
      abv: bottles.abv,
      ageYears: bottles.ageYears,
      caskTypes: bottles.caskTypes,
      mashBill: bottles.mashBill,
      country: bottles.country,
      job: bottleEnrichmentJobs,
    })
    .from(bottles)
    .leftJoin(bottleEnrichmentJobs, eq(bottleEnrichmentJobs.bottleId, bottles.id))
    .where(and(eq(bottles.id, bottleId), catalogVisibleTo(viewerId)))
    .limit(1);
  if (!row) return null;
  const job = row.job;
  const events = job
    ? await db
        .select()
        .from(bottleEnrichmentEvents)
        .where(and(eq(bottleEnrichmentEvents.jobId, job.id), gt(bottleEnrichmentEvents.seq, afterSeq)))
        .orderBy(asc(bottleEnrichmentEvents.seq))
        .limit(100)
    : [];
  let waiting: string | null = null;
  if (job?.state === "queued") {
    waiting = job.waitingReason ?? (now.getTime() - job.createdAt.getTime() > ENRICH_STALE_QUEUE_MS ? "stale" : null);
  }
  return {
    job: job
      ? {
          reason: job.reason,
          state: job.state,
          stepsDone: job.stepsDone,
          waiting,
          createdAt: job.createdAt.toISOString(),
          claimedAt: job.claimedAt?.toISOString() ?? null,
          finishedAt: job.finishedAt?.toISOString() ?? null,
          lastSeq: job.lastSeq,
        }
      : null,
    events: events.map((e) => ({ seq: e.seq, kind: e.kind, step: e.step, message: e.message, data: e.data, at: e.createdAt.toISOString() })),
    fields: {
      profile: row.flavorProfile,
      abv: row.abv,
      ageYears: row.ageYears,
      caskTypes: row.caskTypes,
      mashBill: row.mashBill,
      country: row.country,
      notes: job?.result?.notes ?? null,
      sources: job?.result?.sources ?? null,
    },
  };
}

/** Queue depth for the admin page. */
export async function queueStats(db: DB, now = new Date()): Promise<{ queued: number; due: number; running: number; done: number; failed: number }> {
  const [r] = rowsOf<{ queued: number; due: number; running: number; done: number; failed: number }>(
    await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
             COUNT(*) FILTER (WHERE state = 'queued' AND not_before <= ${ts(now)})::int AS due,
             COUNT(*) FILTER (WHERE state = 'running')::int AS running,
             COUNT(*) FILTER (WHERE state = 'done')::int AS done,
             COUNT(*) FILTER (WHERE state = 'failed')::int AS failed
      FROM bottle_enrichment_jobs`),
  );
  return {
    queued: Number(r?.queued ?? 0),
    due: Number(r?.due ?? 0),
    running: Number(r?.running ?? 0),
    done: Number(r?.done ?? 0),
    failed: Number(r?.failed ?? 0),
  };
}

/** The latest jobs with their bottle names, for the admin queue table. */
export async function recentJobs(db: DB, limit = 25) {
  return db
    .select({
      id: bottleEnrichmentJobs.id,
      bottleId: bottleEnrichmentJobs.bottleId,
      bottleName: bottles.name,
      reason: bottleEnrichmentJobs.reason,
      state: bottleEnrichmentJobs.state,
      stepsDone: bottleEnrichmentJobs.stepsDone,
      attempts: bottleEnrichmentJobs.attempts,
      waitingReason: bottleEnrichmentJobs.waitingReason,
      error: bottleEnrichmentJobs.error,
      createdAt: bottleEnrichmentJobs.createdAt,
      finishedAt: bottleEnrichmentJobs.finishedAt,
    })
    .from(bottleEnrichmentJobs)
    .innerJoin(bottles, eq(bottles.id, bottleEnrichmentJobs.bottleId))
    .orderBy(sql`${bottleEnrichmentJobs.createdAt} DESC`)
    .limit(limit);
}

/** Retention: events of long-finished jobs, and old call/run rows (cron sweep). */
export async function sweepEnrichment(db: DB, now = new Date()): Promise<void> {
  const cutoff30 = new Date(now.getTime() - 30 * 86_400_000);
  const cutoff90 = new Date(now.getTime() - 90 * 86_400_000);
  await db.execute(sql`DELETE FROM bottle_enrichment_events e USING bottle_enrichment_jobs j
    WHERE e.job_id = j.id AND j.state IN ('done', 'failed') AND j.finished_at < ${ts(cutoff30)}`);
  await db.execute(sql`DELETE FROM enrichment_calls WHERE created_at < ${ts(cutoff90)}`);
  await db.execute(sql`DELETE FROM enrichment_runs WHERE started_at < ${ts(cutoff90)}`);
}
