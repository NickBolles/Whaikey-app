import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import type { AiFeature } from "@/db/schema";

/**
 * What each AI call cost, in tokens (PLAN-A3).
 *
 * Recorded explicitly at each call site rather than by wrapping the client,
 * for the same reason `reserveAiRequest` is: the client layer does not know
 * whose request this is. A Proxy around `messages.create` would have the token
 * counts and no user id, which answers the wrong half of the question. Six
 * call sites is the honest price of the id being available.
 *
 * **Never throws.** Recording what a call cost must not be able to fail the
 * call that already succeeded — the user has their answer, and losing a
 * telemetry row is cheaper than losing the response.
 */

export interface AiUsageInput {
  /** Null for work nobody asked for: scheduled catalog enrichment. */
  userId: string | null;
  feature: AiFeature;
  model: string;
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null | undefined;
}

/**
 * Per-million-token rates, applied at READ time.
 *
 * Deliberately not stored on the row. Prices change, and a dollar figure
 * written into the database becomes a lie the day they do — with no way to
 * correct history, because the tokens it was derived from would be gone. Same
 * rule `docs/COMPETITORS.md` §2.7 sets for bottle valuations: show what is
 * known, never a precision that isn't there.
 *
 * A model absent from this table falls back to the most expensive entry rather
 * than to zero: an unknown model costing nothing is the failure mode that
 * makes a budget alarm silent exactly when a new model is rolled out.
 */
export interface ModelRate {
  input: number;
  output: number;
}

/**
 * Per-million-token INPUT/OUTPUT rates, applied at READ time.
 *
 * Deliberately not stored on the row. Prices change, and a dollar figure
 * written into the database becomes a lie the day they do — with no way to
 * correct history, because the tokens it was derived from would be gone. Same
 * rule `docs/COMPETITORS.md` §2.7 sets for bottle valuations: show what is
 * known, never a precision that isn't there.
 *
 * These are Anthropic's first-party rates. When `OPENROUTER_API_KEY` is set —
 * which `activeAiProvider()` PREFERS — the bill is OpenRouter's and its
 * margin is its own, so every figure derived from this table is an estimate of
 * the right order rather than an invoice. `estimatedUsd` is named that way on
 * purpose.
 */
const RATES: Record<string, ModelRate> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Previous generation, still reachable: `chatModel()` returns
  // `anthropic/claude-sonnet-4` on the OpenRouter path, which normalises here.
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
};

/** Cache reads bill at ~0.1x input; cache writes at ~1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Reduce a deployed model id to the family the rate table is keyed on.
 *
 * **This is the difference between a cost figure and a false alarm.** The
 * repo's PREFERRED provider is OpenRouter (AGENTS.md), whose ids are
 * `anthropic/claude-sonnet-4` and `anthropic/claude-haiku-4.5` — a provider
 * prefix and a dot where the first-party id has a dash. Matched raw, neither
 * hits any key, so ordinary traffic on the default configuration fell through
 * to the deliberate unknown-model fallback and was priced at the most
 * expensive rate in the table. A budget alarm that reads several times high on
 * every deployment is not a conservative alarm, it is a broken one.
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    // Provider route prefix: "anthropic/", "openrouter/anthropic/".
    .replace(/^(?:[a-z0-9_-]+\/)+/, "")
    // "claude-haiku-4.5" and "claude-haiku-4-5" are the same model.
    .replace(/\./g, "-")
    // Dated snapshots: "claude-haiku-4-5-20251001".
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
}

/**
 * The dearest rate in the table — what an unrecognised model is charged.
 *
 * Failing free is how a budget alarm goes silent exactly when a new model is
 * rolled out, which is when it is most needed. Computed rather than hardcoded
 * so it cannot drift out of step with the table above.
 */
function dearestRate(): ModelRate {
  return Object.values(RATES).reduce((a, b) => (b.output > a.output ? b : a));
}

export function rateFor(model: string): ModelRate {
  const id = normalizeModelId(model);
  const exact = RATES[id];
  if (exact) return exact;
  // Longest prefix first: "claude-sonnet-4-6" must not be answered by
  // "claude-sonnet-4" simply because it was declared earlier.
  const keys = Object.keys(RATES).sort((a, b) => b.length - a.length);
  for (const known of keys) {
    if (id.startsWith(known)) return RATES[known];
  }
  return dearestRate();
}

/** Whether this model was priced from the table or from the fallback. */
export function isKnownModel(model: string): boolean {
  const id = normalizeModelId(model);
  return Object.keys(RATES).some((known) => id === known || id.startsWith(known));
}

export function usdForTokens(
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number },
): number {
  const rate = rateFor(model);
  return (
    (tokens.inputTokens * rate.input +
      tokens.outputTokens * rate.output +
      tokens.cachedInputTokens * rate.input * CACHE_READ_MULTIPLIER +
      tokens.cacheWriteTokens * rate.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  );
}

/** Record one model call's token spend. Best-effort; never throws. */
export async function recordAiUsage(db: DB, input: AiUsageInput): Promise<void> {
  const u = input.usage;
  // A response with no usage block tells us nothing, and a row of zeroes would
  // read as "this call was free" rather than "we did not learn what it cost".
  if (!u) return;
  try {
    await db.insert(schema.aiUsage).values({
      id: crypto.randomUUID(),
      userId: input.userId,
      feature: input.feature,
      model: input.model,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cachedInputTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    });
  } catch (err) {
    console.error("[ai-usage] failed to record token spend", err);
  }
}

export interface AiCostRow {
  feature: AiFeature;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
}

/**
 * What AI has cost since `since`, split by feature and model.
 *
 * Split rather than totalled because "AI cost" is not one number and the
 * actionable answer is which feature is expensive — a single figure tells an
 * operator that it is too high and nothing about what to do.
 */
export async function aiCostSince(
  db: DB,
  since: Date,
  opts: { userId?: string } = {},
): Promise<AiCostRow[]> {
  const rows = await db
    .select({
      feature: schema.aiUsage.feature,
      model: schema.aiUsage.model,
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`sum(${schema.aiUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${schema.aiUsage.outputTokens})`,
      cachedInputTokens: sql<number>`sum(${schema.aiUsage.cachedInputTokens})`,
      cacheWriteTokens: sql<number>`sum(${schema.aiUsage.cacheWriteTokens})`,
    })
    .from(schema.aiUsage)
    .where(
      opts.userId
        ? and(gte(schema.aiUsage.createdAt, since), eq(schema.aiUsage.userId, opts.userId))
        : gte(schema.aiUsage.createdAt, since),
    )
    .groupBy(schema.aiUsage.feature, schema.aiUsage.model)
    // A stable base order only; the meaningful sort is by cost, below, and
    // cannot be done here because the price table lives in TypeScript.
    .orderBy(desc(sql`sum(${schema.aiUsage.outputTokens})`));

  const priced = rows.map((r) => {
    const tokens = {
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      cachedInputTokens: Number(r.cachedInputTokens ?? 0),
      cacheWriteTokens: Number(r.cacheWriteTokens ?? 0),
    };
    return {
      feature: r.feature,
      model: r.model,
      calls: Number(r.calls ?? 0),
      ...tokens,
      estimatedUsd: usdForTokens(r.model, tokens),
    };
  });

  /**
   * Sorted by what it COSTS, not by how many tokens came out.
   *
   * Output tokens were a proxy for spend, and a bad one the moment more than
   * one model is in the mix — which is the normal state here: chat runs on
   * Sonnet while scanning and extraction run on Haiku, at a fifth of the
   * output price. It also ignored input and cache charges entirely, which for
   * a long-context feature are most of the bill. So a cheap Haiku row could
   * sit above a materially more expensive Sonnet one, and this list exists
   * precisely to point an operator at the feature worth looking at first.
   *
   * Sorted in TypeScript because the rates are a TypeScript table; the SQL
   * `orderBy` above is left as a deterministic tiebreak for equal cost.
   */
  return priced.sort((a, b) => b.estimatedUsd - a.estimatedUsd);
}

/**
 * The PLAN-A3 number: mean spend per account that used AI in the window.
 *
 * The denominator is accounts that actually made a call, not all accounts —
 * dividing by everyone would make the figure fall as the app grew, which is
 * the wrong direction for a budget alarm to move.
 */
export async function meanAiCostPerActiveUser(
  db: DB,
  since: Date,
): Promise<{ users: number; totalUsd: number; meanUsd: number }> {
  const rows = await db
    .select({
      userId: schema.aiUsage.userId,
      model: schema.aiUsage.model,
      inputTokens: sql<number>`sum(${schema.aiUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${schema.aiUsage.outputTokens})`,
      cachedInputTokens: sql<number>`sum(${schema.aiUsage.cachedInputTokens})`,
      cacheWriteTokens: sql<number>`sum(${schema.aiUsage.cacheWriteTokens})`,
    })
    .from(schema.aiUsage)
    .where(and(gte(schema.aiUsage.createdAt, since), sql`${schema.aiUsage.userId} is not null`))
    .groupBy(schema.aiUsage.userId, schema.aiUsage.model);

  const users = new Set<string>();
  let totalUsd = 0;
  for (const r of rows) {
    if (r.userId) users.add(r.userId);
    totalUsd += usdForTokens(r.model, {
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      cachedInputTokens: Number(r.cachedInputTokens ?? 0),
      cacheWriteTokens: Number(r.cacheWriteTokens ?? 0),
    });
  }
  return { users: users.size, totalUsd, meanUsd: users.size === 0 ? 0 : totalUsd / users.size };
}
