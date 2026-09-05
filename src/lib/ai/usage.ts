import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import type { AiFeature } from "@/db/schema";
import { reportInBackground } from "@/lib/observability/errors";

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
    /** Hosted tools the model called itself, billed per request. */
    server_tool_use?: {
      web_search_requests?: number | null;
      web_fetch_requests?: number | null;
    } | null;
  } | null | undefined;
}

/** Per-million-token input/output prices for one model over one period. */
export interface ModelRate {
  input: number;
  output: number;
}

/** A rate together with the UTC date it took effect (`YYYY-MM-DD`). */
export interface DatedRate extends ModelRate {
  from: string;
}

/**
 * The date every rate below is anchored to.
 *
 * `ai_usage` is introduced by this change, so no usage row can predate the
 * table — which makes the history **complete by construction** rather than
 * complete by assertion. Every figure this module has ever produced was
 * produced from a rate recorded here.
 */
const SINCE_FIRST_ROW = "1970-01-01";

/**
 * Per-million-token INPUT/OUTPUT rates, keyed by model family and **dated**.
 *
 * Deliberately not stored on the row. Prices change, and a dollar figure
 * written into the database becomes a lie the day they do — with no way to
 * correct history, because the tokens it was derived from would be gone. Same
 * rule `docs/COMPETITORS.md` §2.7 sets for bottle valuations: show what is
 * known, never a precision that isn't there.
 *
 * Storing tokens is what makes history *correctable*; dating the rates is what
 * makes it *stable*. Without the dates, editing a price here silently reprices
 * every row still inside the 90-day retention window, so a report headed "last
 * 30 days" would state today's price applied to spend that was never billed at
 * it — the mirror image of the bug that keeping dollars off the row avoids,
 * and just as wrong.
 *
 * **So a price change APPENDS an entry; it never edits one.** Entries are
 * oldest first, `from` is a UTC date, and pricing picks the entry in effect
 * when the call was made. Editing a number in place is the one operation this
 * table cannot survive, because the old rate is then unrecoverable.
 *
 * These are Anthropic's first-party rates. When `OPENROUTER_API_KEY` is set —
 * which `activeAiProvider()` PREFERS — the bill is OpenRouter's and its
 * margin is its own, so every figure derived from this table is an estimate of
 * the right order rather than an invoice. `estimatedUsd` is named that way on
 * purpose.
 */
let RATES: Record<string, DatedRate[]> = {
  "claude-opus-5": [{ from: SINCE_FIRST_ROW, input: 5, output: 25 }],
  "claude-sonnet-5": [{ from: SINCE_FIRST_ROW, input: 2, output: 10 }],
  "claude-haiku-4-5": [{ from: SINCE_FIRST_ROW, input: 1, output: 5 }],
  // Previous generation, still reachable: `chatModel()` returns
  // `anthropic/claude-sonnet-4` on the OpenRouter path, which normalises here.
  "claude-sonnet-4-6": [{ from: SINCE_FIRST_ROW, input: 3, output: 15 }],
  "claude-sonnet-4": [{ from: SINCE_FIRST_ROW, input: 3, output: 15 }],
};

const DEFAULT_RATES = RATES;

/**
 * Swap the rate table, for tests only. Returns nothing; call with no argument
 * to restore.
 *
 * The same seam as `setAnthropicForTests` in `src/lib/ai/client.ts`, and for
 * the same reason: the interesting behaviour here is what happens when a price
 * CHANGES, and every entry in the real table shares one effective date because
 * no price has changed yet. Without a way to supply a table that has a second
 * entry, the dating below would ship with its integration untested — which is
 * how it would quietly stop being applied. Pricing is an operator estimate
 * rather than a security boundary, so a test-time swap costs nothing real.
 */
export function setRateTableForTests(rates?: Record<string, DatedRate[]>): void {
  RATES = rates ?? DEFAULT_RATES;
}

/** A hosted-tool price, per REQUEST rather than per million tokens. */
interface DatedToolRate {
  from: string;
  usdPerRequest: number;
}

/**
 * Hosted tools the model calls itself, billed per request beside the tokens.
 *
 * Catalog enrichment enables Anthropic's hosted web search for bottles with no
 * source facts (`src/lib/ingest/enrich.ts`), and each search is charged
 * separately from the token meter. Counting only tokens left a real and
 * recurring line of the bill out of the report whose entire purpose is to show
 * what AI costs — the same failure as pricing an unknown model at zero, in a
 * different unit.
 *
 * Dated for the reason the model rates are, and appended to rather than
 * edited: a tool price moves exactly as a token price does, and dating one and
 * not the other would leave half the report repricing its own history.
 */
const TOOL_RATES: { webSearch: DatedToolRate[] } = {
  // Anthropic's published hosted web-search price: $10 per 1,000 searches.
  webSearch: [{ from: SINCE_FIRST_ROW, usdPerRequest: 10 / 1000 }],
};

/** Cache reads bill at ~0.1x input; cache writes at ~1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Midnight UTC on a `YYYY-MM-DD` date, as milliseconds. */
function utcMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * The entry in effect at `at`, or `undefined` if this model had no price yet.
 *
 * `undefined` rather than "the earliest entry" because the two answers differ
 * exactly where it matters. A model added to the table later did not exist
 * before its first entry, and lending it a rate backwards puts it into
 * `dearestRate`'s comparison for dates it could not have been called on —
 * which reprices every unknown-model row in the archive the moment somebody
 * adds a dearer model. That is the defect this dating exists to close,
 * arriving through the fallback instead of through the lookup.
 */
function rateAt(entries: DatedRate[], at: Date): ModelRate | undefined {
  const ms = at.getTime();
  let chosen: DatedRate | undefined;
  for (const entry of entries) {
    if (utcMidnight(entry.from) <= ms) chosen = entry;
  }
  return chosen ? { input: chosen.input, output: chosen.output } : undefined;
}

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
/** The hosted-tool entry in effect at `at`, or `undefined` before the first. */
function rateAtTool(entries: DatedToolRate[], at: Date): DatedToolRate | undefined {
  const ms = at.getTime();
  let chosen: DatedToolRate | undefined;
  for (const entry of entries) {
    if (utcMidnight(entry.from) <= ms) chosen = entry;
  }
  return chosen;
}

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
 * The dearest rate **in effect at `at`** — what an unrecognised model is charged.
 *
 * Failing free is how a budget alarm goes silent exactly when a new model is
 * rolled out, which is when it is most needed. Computed rather than hardcoded
 * so it cannot drift out of step with the table above.
 *
 * Scoped to `at` for the same reason every other lookup here is. Adding a
 * dearer model tomorrow would otherwise reprice today's unknown-model rows at
 * a rate that did not exist when the call was made — history moving because
 * the table grew, which is the defect this dating exists to close, arriving
 * through the fallback instead of through the family lookup.
 */
function dearestRate(at: Date): ModelRate {
  const live = Object.values(RATES)
    .map((entries) => rateAt(entries, at))
    .filter((r): r is ModelRate => r !== undefined);
  // Before the table's own earliest entry nothing was in effect, which cannot
  // happen for a real row — `ai_usage` starts with this table — but must still
  // answer something, and the dearest first-known rate is the safe direction.
  const pool = live.length > 0 ? live : Object.values(RATES).map((e) => e[0]);
  return pool.reduce((a, b) => (b.output > a.output ? b : a));
}

/**
 * Does `id` name the SAME family as `known`, rather than merely start with it?
 *
 * A bare `startsWith` answered `claude-sonnet-4-7` — a version nobody has
 * priced — with `claude-sonnet-4`'s $3/$15, instead of falling through to the
 * deliberately dearest unknown-model rate. That is the one direction this
 * table must never fail in: the whole point of pricing an unknown model at the
 * top of the range is that a cost alarm should cry wolf rather than sleep
 * through a new model costing more than the last one. Silently inheriting an
 * older, cheaper family's rate is exactly the sleeping case, and `-4-6`
 * already existing as its own entry shows point releases really do get their
 * own prices.
 *
 * So a match needs a version boundary: either the id IS the family, or what
 * follows is a date snapshot (`claude-sonnet-4-20250514`), which is the same
 * model with a pin rather than a new one. Anything else — another version
 * segment, a suffix nobody here has seen — is unknown, and is priced as such
 * until somebody adds a row.
 */
function isSameFamily(id: string, known: string): boolean {
  if (id === known) return true;
  if (!id.startsWith(`${known}-`)) return false;
  // `normalizeModelId` already strips a trailing 8-digit snapshot, so anything
  // left here is a further version segment rather than a pin.
  return /^\d{8}$/.test(id.slice(known.length + 1));
}

/**
 * The rate for `model` as it stood at `at` (default: now).
 *
 * Callers pricing historical rows MUST pass the time the call was made; the
 * default exists for "what would this cost today" questions, not for reports.
 */
export function rateFor(model: string, at: Date = new Date()): ModelRate {
  const id = normalizeModelId(model);
  const exact = RATES[id];
  if (exact) return rateAt(exact, at) ?? dearestRate(at);
  // Longest first: "claude-sonnet-4-6" must not be answered by
  // "claude-sonnet-4" simply because it was declared earlier.
  const keys = Object.keys(RATES).sort((a, b) => b.length - a.length);
  for (const known of keys) {
    // A known family with no rate in effect yet is priced as an unknown model
    // rather than at its own later price: we do not know what it cost then,
    // and the unknown fallback is the direction that fails loud.
    if (isSameFamily(id, known)) return rateAt(RATES[known], at) ?? dearestRate(at);
  }
  return dearestRate(at);
}

/** Whether this model was priced from the table or from the fallback. */
export function isKnownModel(model: string): boolean {
  const id = normalizeModelId(model);
  // Same boundary rule as `rateFor`, so the two cannot disagree about whether
  // a model is known — which would be worse than either answer alone.
  return Object.keys(RATES).some((known) => isSameFamily(id, known));
}

/**
 * Price a bundle of tokens for `model` at the rate in effect at `at`.
 *
 * `at` defaults to now for the "what would this cost today" question. Anything
 * summing rows out of `ai_usage` must pass the time those rows were written,
 * or a later price change moves a figure that has already been reported.
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /** Hosted searches, billed per request. Absent is treated as none. */
  webSearchRequests?: number;
  webFetchRequests?: number;
}

export function usdForTokens(model: string, tokens: UsageTotals, at: Date = new Date()): number {
  const rate = rateFor(model, at);
  const tokenUsd =
    (tokens.inputTokens * rate.input +
      tokens.outputTokens * rate.output +
      tokens.cachedInputTokens * rate.input * CACHE_READ_MULTIPLIER +
      tokens.cacheWriteTokens * rate.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  const search = rateAtTool(TOOL_RATES.webSearch, at);
  const toolUsd = (tokens.webSearchRequests ?? 0) * (search?.usdPerRequest ?? 0);
  /**
   * `webFetchRequests` is recorded and NOT priced, which is a stated gap
   * rather than a silent zero. No fetch tool is enabled anywhere in this
   * codebase — catalog enrichment turns on `web_search_20260209` and nothing
   * else — so the column is always 0 today, and inventing a rate for a tool
   * nobody has turned on is the false precision `docs/COMPETITORS.md` §2.7
   * rules out. The count is stored anyway because the API reports both halves
   * of the meter in one object, and recording half of a meter is exactly how
   * the search half went missing. **Enable a fetch tool and add its rate in
   * the same commit.**
   */
  return tokenUsd + toolUsd;
}

/** Record one model call's token spend. Best-effort; never throws. */
export async function recordAiUsage(db: DB, input: AiUsageInput): Promise<void> {
  const u = input.usage;
  /**
   * A row of zeroes would read as "this call was free" rather than "we did not
   * learn what it cost" — and until now that sentence was a comment describing
   * a rule the code below did not enforce. It guarded a MISSING usage block
   * and not an all-zero one, so `makeClaudeCodeClient`, which fabricates
   * `{ input_tokens: 0, output_tokens: 0 }` because the CLI does not surface a
   * meter on this path, wrote a $0 row for every enrichment call. The operator
   * report then claimed a paid AI surface was free, which is worse than a gap:
   * a blank invites the question, a zero answers it wrongly.
   *
   * Guarded at the seam rather than at that one client, because any future
   * transport that cannot report a meter will produce the same shape, and the
   * rule belongs where the sentence explaining it already lives.
   *
   * (Whether the Claude Code CLI's JSON result carries real usage we could
   * plumb through instead is a separate question and not one I have verified;
   * omitting the row is correct either way, and correct sooner.)
   */
  if (!u) return;
  const webSearchRequests = u.server_tool_use?.web_search_requests ?? 0;
  const webFetchRequests = u.server_tool_use?.web_fetch_requests ?? 0;
  // Hosted tool calls count towards "did we learn anything" as well: a turn
  // that searched is a turn that cost money, whatever the token meter says.
  const total =
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    webSearchRequests +
    webFetchRequests;
  if (total === 0) return;
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
      webSearchRequests,
      webFetchRequests,
    });
  } catch (err) {
    console.error("[ai-usage] failed to record token spend", err);
    /**
     * Best-effort, and reported. Losing a telemetry row is cheaper than losing
     * the response, which is why this catch exists — but a write that fails
     * PERSISTENTLY (a column this deployment has not migrated, a constraint,
     * a permission) makes every paid call vanish from the cost totals while
     * every request still succeeds. Nothing user-facing goes wrong, so no
     * wrapper above this can see it: the budget alarm simply reads zero, which
     * is the exact failure the unknown-model and all-zero rules exist to
     * prevent, arriving through the recorder rather than the price table.
     */
    reportInBackground(err, {
      where: "ai/usage:record",
      // Null is the scheduled enrichment job, which has no user to name.
      userId: input.userId ?? undefined,
      tags: { feature: input.feature, model: input.model },
    });
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
  /** Hosted tool calls, billed per request rather than per token. */
  webSearchRequests: number;
  webFetchRequests: number;
  estimatedUsd: number;
}

/**
 * A UTC-day bucket (`YYYY-MM-DD`) for a usage row, used as the pricing epoch.
 *
 * Aggregates group on this as well as on the model so each bucket can be
 * priced at the rate that was in effect while it accrued. Day granularity is
 * exact rather than approximate here: rate entries carry a UTC **date**, and
 * these buckets are UTC days, so no bucket can straddle a price change.
 *
 * `at time zone 'UTC'` is explicit because `date_trunc` would otherwise use
 * the session's TimeZone, which differs between the PGlite used in tests and a
 * deployed Postgres — a report whose totals depend on server configuration.
 */
const usageDay = sql<string>`to_char(${schema.aiUsage.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

/** Midnight UTC on a bucket returned by `usageDay`. */
function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
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
 *
 * Grouped by UTC day underneath and folded back afterwards, so each day's
 * tokens are priced at that day's rate. The returned rows are still one per
 * (feature, model); the day only decides the price.
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
      day: usageDay,
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`sum(${schema.aiUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${schema.aiUsage.outputTokens})`,
      cachedInputTokens: sql<number>`sum(${schema.aiUsage.cachedInputTokens})`,
      cacheWriteTokens: sql<number>`sum(${schema.aiUsage.cacheWriteTokens})`,
      webSearchRequests: sql<number>`sum(${schema.aiUsage.webSearchRequests})`,
      webFetchRequests: sql<number>`sum(${schema.aiUsage.webFetchRequests})`,
    })
    .from(schema.aiUsage)
    .where(
      opts.userId
        ? and(gte(schema.aiUsage.createdAt, since), eq(schema.aiUsage.userId, opts.userId))
        : gte(schema.aiUsage.createdAt, since),
    )
    .groupBy(schema.aiUsage.feature, schema.aiUsage.model, usageDay);

  const byPair = new Map<string, AiCostRow>();
  for (const r of rows) {
    const tokens = {
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      cachedInputTokens: Number(r.cachedInputTokens ?? 0),
      cacheWriteTokens: Number(r.cacheWriteTokens ?? 0),
      webSearchRequests: Number(r.webSearchRequests ?? 0),
      webFetchRequests: Number(r.webFetchRequests ?? 0),
    };
    const key = `${r.feature}\u0000${r.model}`;
    const acc = byPair.get(key) ?? {
      feature: r.feature,
      model: r.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      estimatedUsd: 0,
    };
    acc.calls += Number(r.calls ?? 0);
    acc.inputTokens += tokens.inputTokens;
    acc.outputTokens += tokens.outputTokens;
    acc.cachedInputTokens += tokens.cachedInputTokens;
    acc.cacheWriteTokens += tokens.cacheWriteTokens;
    acc.webSearchRequests += tokens.webSearchRequests;
    acc.webFetchRequests += tokens.webFetchRequests;
    acc.estimatedUsd += usdForTokens(r.model, tokens, dayStart(r.day));
    byPair.set(key, acc);
  }

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
   * Output tokens remain the tiebreak for equal cost, so the order is stable
   * without depending on the database's grouping order.
   */
  return [...byPair.values()].sort(
    (a, b) => b.estimatedUsd - a.estimatedUsd || b.outputTokens - a.outputTokens,
  );
}

/**
 * The PLAN-A3 number: mean spend per account that used AI in the window.
 *
 * The denominator is accounts that actually made a call, not all accounts —
 * dividing by everyone would make the figure fall as the app grew, which is
 * the wrong direction for a budget alarm to move.
 *
 * Two aggregates rather than one scan. The earlier shape selected a row per
 * (user, model) and counted the distinct users in TypeScript, so the work grew
 * with the user base on a page an operator opens when something is already
 * wrong. Neither query here returns more than (models x days) rows whatever
 * the size of the account table, and splitting them is what lets the cost side
 * be grouped by day and priced at the rate of the day it accrued.
 *
 * Both halves keep `user_id is not null`: scheduled catalog enrichment is
 * nobody's request, so it belongs in neither the numerator nor the denominator
 * of a per-user figure.
 */
export async function meanAiCostPerActiveUser(
  db: DB,
  since: Date,
): Promise<{ users: number; totalUsd: number; meanUsd: number }> {
  const attributed = and(
    gte(schema.aiUsage.createdAt, since),
    sql`${schema.aiUsage.userId} is not null`,
  );

  const [counted, rows] = await Promise.all([
    db
      .select({ users: sql<number>`count(distinct ${schema.aiUsage.userId})` })
      .from(schema.aiUsage)
      .where(attributed),
    db
      .select({
        model: schema.aiUsage.model,
        day: usageDay,
        inputTokens: sql<number>`sum(${schema.aiUsage.inputTokens})`,
        outputTokens: sql<number>`sum(${schema.aiUsage.outputTokens})`,
        cachedInputTokens: sql<number>`sum(${schema.aiUsage.cachedInputTokens})`,
        cacheWriteTokens: sql<number>`sum(${schema.aiUsage.cacheWriteTokens})`,
        webSearchRequests: sql<number>`sum(${schema.aiUsage.webSearchRequests})`,
        webFetchRequests: sql<number>`sum(${schema.aiUsage.webFetchRequests})`,
      })
      .from(schema.aiUsage)
      .where(attributed)
      .groupBy(schema.aiUsage.model, usageDay),
  ]);

  const users = Number(counted[0]?.users ?? 0);
  let totalUsd = 0;
  for (const r of rows) {
    totalUsd += usdForTokens(
      r.model,
      {
        inputTokens: Number(r.inputTokens ?? 0),
        outputTokens: Number(r.outputTokens ?? 0),
        cachedInputTokens: Number(r.cachedInputTokens ?? 0),
        cacheWriteTokens: Number(r.cacheWriteTokens ?? 0),
        webSearchRequests: Number(r.webSearchRequests ?? 0),
        webFetchRequests: Number(r.webFetchRequests ?? 0),
      },
      dayStart(r.day),
    );
  }
  return { users, totalUsd, meanUsd: users === 0 ? 0 : totalUsd / users };
}
