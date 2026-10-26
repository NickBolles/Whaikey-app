import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { bottleFlavorProvenance, enrichmentCalls, enrichmentSettings, FLAVOR_PROFILE_TIERS, type FlavorProfileTier } from "@/db/schema";
import { recordAiUsage, usdForTokens } from "@/lib/ai/usage";
import { reportInBackground } from "@/lib/observability/errors";
import { enrichEnabledByEnv, getEnrichProvider, type CallUsage, type EnrichProviderName } from "./providers";

/**
 * Spend control for enrichment: one settings row (pause, daily cap), one
 * `enrichment_calls` row per model call, and the gate every call passes
 * first. The cap is a HARD stop: a call is made only when today's spend plus
 * that call's worst-case estimate fits under it — and the estimate is
 * RESERVED (written as a pending row under a transaction-scoped advisory
 * lock) before the call starts, so calls running at the same time on
 * different bottles or chunks can't all pass the check on the same spend.
 */

export const DEFAULT_DAILY_BUDGET_USD = 2;
/** Worst-case estimates per call, used to stop BEFORE crossing the cap. */
export const CALL_ESTIMATE_USD = { quick: 0.01, web: 0.2, "batch-quick": 0.03, "batch-web": 0.2 } as const;
export type CallStep = keyof typeof CALL_ESTIMATE_USD;

export interface EnrichSettings {
  paused: boolean;
  dailyBudgetUsd: number;
  missingCursor: string | null;
}

export async function getSettings(db: DB): Promise<EnrichSettings> {
  const [row] = await db.select().from(enrichmentSettings).where(eq(enrichmentSettings.id, "global"));
  return {
    paused: row?.paused ?? false,
    dailyBudgetUsd: row?.dailyBudgetUsd ?? DEFAULT_DAILY_BUDGET_USD,
    missingCursor: row?.missingCursor ?? null,
  };
}

export async function updateSettings(db: DB, patch: Partial<EnrichSettings>): Promise<EnrichSettings> {
  const current = await getSettings(db);
  // An omitted field keeps its value (`{ paused: false }` must not reset the cap).
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<EnrichSettings>;
  const next = { ...current, ...defined };
  await db
    .insert(enrichmentSettings)
    .values({ id: "global", paused: next.paused, dailyBudgetUsd: next.dailyBudgetUsd, missingCursor: next.missingCursor, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: enrichmentSettings.id,
      set: { paused: next.paused, dailyBudgetUsd: next.dailyBudgetUsd, missingCursor: next.missingCursor, updatedAt: new Date() },
    });
  return next;
}

export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

type CallRow = typeof enrichmentCalls.$inferSelect;

export function callUsd(
  row: Pick<CallRow, "model" | "inputTokens" | "outputTokens" | "cachedInputTokens" | "webSearches" | "createdAt"> &
    Partial<Pick<CallRow, "pending" | "reservedUsd">>,
): number {
  // An open reservation counts at its worst-case estimate; a failed call
  // whose usage never came back keeps its estimate on top of what is known.
  if (row.pending) return row.reservedUsd ?? 0;
  return (row.reservedUsd ?? 0) + usdForTokens(
    row.model,
    {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheWriteTokens: 0,
      webSearchRequests: row.webSearches,
    },
    row.createdAt,
  );
}

/** Estimated USD spent since `since` (default: UTC midnight). */
export async function spendSince(db: DB, since = utcDayStart()): Promise<number> {
  const rows = await db.select().from(enrichmentCalls).where(gte(enrichmentCalls.createdAt, since));
  return rows.reduce((sum, r) => sum + callUsd(r), 0);
}

export type GateResult = { ok: true } | { ok: false; reason: "disabled" | "paused" | "budget" };

/** May a model call of this kind run now? */
export async function canSpend(db: DB, step: CallStep, now = new Date()): Promise<GateResult> {
  if (!enrichEnabledByEnv() || !getEnrichProvider()) return { ok: false, reason: "disabled" };
  const settings = await getSettings(db);
  if (settings.paused) return { ok: false, reason: "paused" };
  const spent = await spendSince(db, utcDayStart(now));
  if (spent + CALL_ESTIMATE_USD[step] > settings.dailyBudgetUsd) return { ok: false, reason: "budget" };
  return { ok: true };
}

/** Serializes every reservation across invocations (any constant works; this one is ours). */
const BUDGET_LOCK_KEY = 4_120_717;

export type ReserveResult = { ok: true; reservationId: string } | { ok: false; reason: "disabled" | "paused" | "budget" };

/**
 * The gate, atomically: under one lock, check pause and today's spend
 * (completed calls + open reservations) + this call's estimate against the
 * cap, and write the reservation. Pass the id to recordCall afterwards, or to
 * releaseCall when no call was made.
 */
/** Input tokens a call may plausibly carry (prompt + hosted search results), for the worst case. */
export const CALL_MAX_INPUT_TOKENS: Record<CallStep, number> = { quick: 4_000, web: 40_000, "batch-quick": 12_000, "batch-web": 40_000 };

/**
 * Worst-case $ for one call: the step's floor, or what the chosen model would
 * charge at the call's own limits — whichever is higher, so a pricier model
 * override still can't slip past the cap.
 */
export function callEstimateUsd(
  step: CallStep,
  model: string,
  limits: { maxOutputTokens?: number; maxSearches?: number } = {},
  at = new Date(),
): number {
  const bound = usdForTokens(
    model,
    {
      inputTokens: CALL_MAX_INPUT_TOKENS[step],
      outputTokens: limits.maxOutputTokens ?? 4_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: limits.maxSearches ?? 0,
    },
    at,
  );
  return Math.max(CALL_ESTIMATE_USD[step], bound);
}

export async function reserveCall(
  db: DB,
  input: {
    step: CallStep;
    provider: EnrichProviderName;
    model: string;
    jobId?: string | null;
    runId?: string | null;
    bottles?: number;
    maxOutputTokens?: number;
    maxSearches?: number;
  },
  now = new Date(),
): Promise<ReserveResult> {
  if (!enrichEnabledByEnv() || !getEnrichProvider()) return { ok: false, reason: "disabled" };
  return db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await t.execute(sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
    const settings = await getSettings(t);
    if (settings.paused) return { ok: false, reason: "paused" } as const;
    const spent = await spendSince(t, utcDayStart(now));
    const estimate = callEstimateUsd(input.step, input.model, { maxOutputTokens: input.maxOutputTokens, maxSearches: input.maxSearches }, now);
    if (spent + estimate > settings.dailyBudgetUsd) return { ok: false, reason: "budget" } as const;
    const reservationId = crypto.randomUUID();
    await t.insert(enrichmentCalls).values({
      id: reservationId,
      jobId: input.jobId ?? null,
      runId: input.runId ?? null,
      step: input.step,
      provider: input.provider,
      model: input.model,
      bottles: input.bottles ?? 1,
      ok: false,
      pending: true,
      reservedUsd: estimate,
      createdAt: now,
    });
    return { ok: true, reservationId } as const;
  });
}

/** Drop a reservation whose call was never made. */
export async function releaseCall(db: DB, reservationId: string): Promise<void> {
  await db.delete(enrichmentCalls).where(and(eq(enrichmentCalls.id, reservationId), eq(enrichmentCalls.pending, true)));
}

export async function recordCall(
  db: DB,
  input: {
    /** The reservation this call made (reserveCall); its row becomes the call's record. */
    reservationId?: string | null;
    jobId?: string | null;
    runId?: string | null;
    step: CallStep;
    provider: EnrichProviderName;
    model: string;
    bottles?: number;
    usage: CallUsage | null;
    ok: boolean;
    error?: string | null;
    latencyMs?: number;
  },
): Promise<void> {
  const u = input.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, webSearches: 0 };
  // A failure with no usage (timeout, dropped connection) may still be billed:
  // the reservation's estimate stays counted rather than reading as free.
  const usageUnknown = !input.ok && u.inputTokens + u.outputTokens + u.cachedInputTokens === 0;
  let settledReservation = false;
  try {
    if (input.reservationId) {
      const settled = await db
        .update(enrichmentCalls)
        .set({
          model: input.model,
          bottles: input.bottles ?? 1,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cachedInputTokens: u.cachedInputTokens,
          webSearches: u.webSearches,
          ok: input.ok,
          error: input.error?.slice(0, 300) ?? null,
          latencyMs: input.latencyMs ?? null,
          pending: false,
          ...(usageUnknown ? {} : { reservedUsd: 0 }),
        })
        .where(eq(enrichmentCalls.id, input.reservationId))
        .returning({ id: enrichmentCalls.id });
      settledReservation = settled.length > 0;
    }
    if (!settledReservation) await db.insert(enrichmentCalls).values({
      id: crypto.randomUUID(),
      jobId: input.jobId ?? null,
      runId: input.runId ?? null,
      step: input.step,
      provider: input.provider,
      model: input.model,
      bottles: input.bottles ?? 1,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedInputTokens: u.cachedInputTokens,
      webSearches: u.webSearches,
      ok: input.ok,
      error: input.error?.slice(0, 300) ?? null,
      latencyMs: input.latencyMs ?? null,
    });
  } catch (err) {
    // The budget gate reads this table: a write that fails silently would
    // let spend run past the cap, so it is reported, not swallowed.
    reportInBackground(err, { where: "enrich/record-call" });
  }
  // The app-wide AI cost report (`ai_usage`) sees enrichment too.
  await recordAiUsage(db, {
    userId: null,
    feature: "enrich",
    model: input.model,
    usage: {
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cache_read_input_tokens: u.cachedInputTokens,
      server_tool_use: { web_search_requests: u.webSearches },
    },
  });
}

export interface DaySpend {
  day: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  usd: number;
}

/** Spend per UTC day for the admin page, newest first. */
export async function spendByDay(db: DB, days = 14, now = new Date()): Promise<DaySpend[]> {
  const since = new Date(utcDayStart(now).getTime() - (days - 1) * 86_400_000);
  const rows = await db
    .select()
    .from(enrichmentCalls)
    .where(gte(enrichmentCalls.createdAt, since))
    .orderBy(desc(enrichmentCalls.createdAt));
  const by = new Map<string, DaySpend>();
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    const d = by.get(day) ?? { day, calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, webSearches: 0, usd: 0 };
    d.calls += 1;
    if (!r.ok) d.failed += 1;
    d.inputTokens += r.inputTokens + r.cachedInputTokens;
    d.outputTokens += r.outputTokens;
    d.webSearches += r.webSearches;
    d.usd += callUsd(r);
    by.set(day, d);
  }
  return [...by.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export function utcMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The last `days` UTC days, oldest first, as "YYYY-MM-DD". */
export function lastUtcDays(days: number, now = new Date()): string[] {
  const start = utcDayStart(now).getTime();
  return Array.from({ length: days }, (_, i) => new Date(start - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

export interface DayEnriched {
  day: string;
  byTier: Record<FlavorProfileTier, number>;
  total: number;
}

/**
 * Profiles written per UTC day by tier, oldest first, every day present (zeros
 * included) — the admin chart. Counted from provenance, so it covers every
 * writer (in-app live/refresh and the bulk Codex pass) and each bottle once,
 * on the day of its latest write.
 */
export async function enrichedByDay(db: DB, days = 30, now = new Date()): Promise<DayEnriched[]> {
  const since = new Date(utcDayStart(now).getTime() - (days - 1) * 86_400_000);
  const rows = await db
    .select({
      day: sql<string>`to_char(${bottleFlavorProvenance.enrichedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      tier: bottleFlavorProvenance.tier,
      n: sql<number>`count(*)::int`,
    })
    .from(bottleFlavorProvenance)
    .where(gte(bottleFlavorProvenance.enrichedAt, since))
    .groupBy(sql`1`, bottleFlavorProvenance.tier);
  const zero = () => Object.fromEntries(FLAVOR_PROFILE_TIERS.map((t) => [t, 0])) as Record<FlavorProfileTier, number>;
  const by = new Map(lastUtcDays(days, now).map((day) => [day, { day, byTier: zero(), total: 0 }]));
  for (const r of rows) {
    const d = by.get(r.day);
    if (!d || !FLAVOR_PROFILE_TIERS.includes(r.tier)) continue;
    d.byTier[r.tier] += Number(r.n);
    d.total += Number(r.n);
  }
  return [...by.values()];
}

/** Spend per UTC day for the chart: oldest first, every day present. */
export async function spendSeries(db: DB, days = 30, now = new Date()): Promise<Array<{ day: string; usd: number; calls: number }>> {
  const spent = new Map((await spendByDay(db, days, now)).map((d) => [d.day, d]));
  return lastUtcDays(days, now).map((day) => ({ day, usd: spent.get(day)?.usd ?? 0, calls: spent.get(day)?.calls ?? 0 }));
}

/** USD per run id, for the recent-runs table. */
export async function spendByRun(db: DB, runIds: string[]): Promise<Map<string, { usd: number; calls: number }>> {
  const out = new Map<string, { usd: number; calls: number }>();
  if (runIds.length === 0) return out;
  const rows = await db
    .select()
    .from(enrichmentCalls)
    .where(and(sql`${enrichmentCalls.runId} IN (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)})`));
  for (const r of rows) {
    const cur = out.get(r.runId as string) ?? { usd: 0, calls: 0 };
    cur.usd += callUsd(r);
    cur.calls += 1;
    out.set(r.runId as string, cur);
  }
  return out;
}
