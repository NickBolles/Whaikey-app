import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic-Messages-compatible client factory for the AI gateway vertical.
 *
 * OpenRouter is preferred when OPENROUTER_API_KEY is configured; it exposes
 * the Anthropic Messages API at a compatible endpoint. Direct Anthropic stays
 * as a fallback for existing deployments. Tests inject a fake client via
 * setAnthropicForTests().
 */

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

type AiProvider = "openrouter" | "anthropic";

let testClient: Anthropic | null = null;
let singleton: Anthropic | null = null;

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI features are not configured");
    this.name = "AiNotConfiguredError";
  }
}

/** The configured production provider, with OpenRouter taking precedence. */
export function activeAiProvider(): AiProvider | null {
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

/** OpenRouter's Anthropic-compatible endpoint does not accept Anthropic's hosted web-search tool. */
export function aiSupportsServerWebSearch(): boolean {
  return activeAiProvider() !== "openrouter";
}

/**
 * Whether to send `cache_control` breakpoints. Only the direct Anthropic API is
 * a guaranteed passthrough; a rejected block would fail the whole request, and
 * caching is an optimization we can always do without.
 */
export function aiSupportsPromptCaching(): boolean {
  return activeAiProvider() === "anthropic";
}

/** Client configuration for the active provider, or null when no key is set. */
export function aiClientOptions(): { apiKey: string; baseURL?: string } | null {
  if (activeAiProvider() === "openrouter") {
    // The SDK appends /v1/messages, so use /api rather than /api/v1 here.
    return { apiKey: process.env.OPENROUTER_API_KEY!, baseURL: OPENROUTER_BASE_URL };
  }
  if (activeAiProvider() === "anthropic") return { apiKey: process.env.ANTHROPIC_API_KEY! };
  return null;
}

/** True when either a test client is injected or an API key is present. */
export function isAiConfigured(): boolean {
  return testClient !== null || aiClientOptions() !== null;
}

/**
 * Budget for a model call (REL-3.1).
 *
 * The SDK defaults to a ten-minute timeout and two retries, which is a fine
 * default for a script and a wrong one here: every AI route caps out at 30-60 s
 * of `maxDuration` and *reserves the user's rate-limit slot before the call*,
 * so a slow model spent someone's hourly budget on a 504 they never saw an
 * answer for.
 *
 * The budget is the whole call, not one attempt, because the platform's kill is
 * on wall time. The shortest route deadline is 30 s (`scan-label`,
 * `extract-note`, `pairings`, `import/analyze`), so 25 s buys one attempt with
 * room to return a real error — and a retry is off, since a second 25 s attempt
 * starting at 25 s is killed at 30 s and reproduces exactly the failure this
 * budget exists to prevent. A retry is worth having, but only with a per-route
 * budget to fit it in; that belongs with the per-feature reservation work in
 * WP-25, not here.
 */
const AI_TIMEOUT_MS = 25_000;
const AI_MAX_RETRIES = 0;
/** Shortest `maxDuration` across the AI routes; the budget above must fit it. */
export const SHORTEST_AI_ROUTE_DEADLINE_MS = 30_000;

/**
 * Budget for a whole agentic turn, not one call.
 *
 * `runChat`/`runChatStream` make up to seven model calls per request, so the
 * per-call timeout above bounds nothing on their own: seven of them is 175 s
 * under `/api/chat`'s 60 s `maxDuration`. Callers that loop share this budget
 * across every call and hand each one whatever is left (`remainingBudget`),
 * ten seconds short of the deadline so there is room to answer with what the
 * loop already has instead of being killed mid-call.
 */
export const AI_LOOP_BUDGET_MS = 50_000;

/**
 * Whatever is left of a budget, or null once it is spent.
 *
 * Null means stop rather than "no limit" — a caller that has run out of time
 * should return what it has, not start another call it cannot finish.
 */
export function remainingBudget(startedAt: number, budgetMs: number): number | null {
  const left = budgetMs - (Date.now() - startedAt);
  // Under a second is not enough for a model call to do anything useful.
  return left > 1_000 ? Math.min(left, AI_TIMEOUT_MS) : null;
}

/**
 * Budget for work that is NOT behind a route.
 *
 * `pnpm ingest enrich` and the catalog-sync workflow batch 25 bottles at 8,000
 * tokens with optional hosted-search continuation turns, and they answer to a
 * job runner rather than a 30 s platform deadline. Capping those at the route
 * budget would abort perfectly good generations; they are slow on purpose.
 */
export const AI_BATCH_TIMEOUT_MS = 5 * 60_000;

/**
 * Give up on `work` once `budgetMs` from `startedAt` has passed.
 *
 * The loop budget has to cover tool execution too, not only model calls: a
 * `get_pairings` miss can sit on a 60 s generation lease, which alone outlives
 * `/api/chat`'s deadline no matter how tight the model timeouts are. The work
 * is not cancelled — it may be a lease another request is legitimately holding
 * — but the loop stops waiting on it and answers with what it has.
 */
export async function withinBudget<T>(
  startedAt: number,
  budgetMs: number,
  work: Promise<T>,
): Promise<T | null> {
  const left = budgetMs - (Date.now() - startedAt);
  if (left <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), left);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Singleton client for Anthropic Messages-compatible calls. OpenRouter is
 * selected first so one OPENROUTER_API_KEY can serve every AI feature.
 */
export function getAnthropic(): Anthropic {
  if (testClient) return testClient;
  const options = aiClientOptions();
  if (!options) throw new AiNotConfiguredError();
  if (!singleton) {
    singleton = new Anthropic({
      ...options,
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
  }
  return singleton;
}

/** Test seam: swap in a fake client (pass null to clear). Resets the singleton. */
export function setAnthropicForTests(client: Anthropic | null): void {
  testClient = client;
  singleton = null;
}

/** Model for chat + pairings. */
export function chatModel(): string {
  if (process.env.WHAIKEY_CHAT_MODEL) return process.env.WHAIKEY_CHAT_MODEL;
  return activeAiProvider() === "openrouter" ? "anthropic/claude-sonnet-4" : "claude-sonnet-5";
}

/** Fast model for extraction + label scan. */
export function fastModel(): string {
  if (process.env.WHAIKEY_FAST_MODEL) return process.env.WHAIKEY_FAST_MODEL;
  return activeAiProvider() === "openrouter"
    ? "anthropic/claude-haiku-4.5"
    : "claude-haiku-4-5-20251001";
}
