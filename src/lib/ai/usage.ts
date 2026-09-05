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
  cachedInput: number;
  cacheWrite: number;
}

export const MODEL_RATES_USD_PER_MTOK: Record<string, ModelRate> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
  "claude-sonnet-5": { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  "claude-opus-5": { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
};

function rateFor(model: string): ModelRate {
  const exact = MODEL_RATES_USD_PER_MTOK[model];
  if (exact) return exact;
  // Prefixes, because deployed ids carry date suffixes the table need not chase.
  for (const [known, rate] of Object.entries(MODEL_RATES_USD_PER_MTOK)) {
    if (model.startsWith(known)) return rate;
  }
  // Fail expensive, not free. See the note above.
  return Object.values(MODEL_RATES_USD_PER_MTOK).reduce((a, b) => (b.output > a.output ? b : a));
}

export function usdForTokens(
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number },
): number {
  const rate = rateFor(model);
  return (
    (tokens.inputTokens * rate.input +
      tokens.outputTokens * rate.output +
      tokens.cachedInputTokens * rate.cachedInput +
      tokens.cacheWriteTokens * rate.cacheWrite) /
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
    .orderBy(desc(sql`sum(${schema.aiUsage.outputTokens})`));

  return rows.map((r) => {
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
