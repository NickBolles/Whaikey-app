import { afterEach, describe, expect, it } from "vitest";
import {
  activeAiProvider,
  aiClientOptions,
  aiSupportsServerWebSearch,
  chatModel,
  fastModel,
  getAnthropic,
  setAnthropicForTests,
  remainingBudget,
  AI_LOOP_BUDGET_MS,
  AI_BATCH_TIMEOUT_MS,
  SHORTEST_AI_ROUTE_DEADLINE_MS,
} from "./client";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("AI provider configuration", () => {
  it("prefers OpenRouter and selects OpenRouter model IDs", () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    expect(activeAiProvider()).toBe("openrouter");
    expect(aiClientOptions()).toEqual({
      apiKey: "test-openrouter-key",
      baseURL: "https://openrouter.ai/api",
    });
    expect(aiSupportsServerWebSearch()).toBe(false);
    expect(chatModel()).toBe("anthropic/claude-sonnet-4");
    expect(fastModel()).toBe("anthropic/claude-haiku-4.5");
  });

  it("falls back to direct Anthropic when OpenRouter is absent", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    expect(activeAiProvider()).toBe("anthropic");
    expect(aiClientOptions()).toEqual({ apiKey: "test-anthropic-key" });
    expect(aiSupportsServerWebSearch()).toBe(true);
    expect(chatModel()).toBe("claude-sonnet-5");
    expect(fastModel()).toBe("claude-haiku-4-5-20251001");
  });
});

describe("model call budget", () => {
  /**
   * REL-3.1. The SDK defaults to a ten-minute timeout and two retries — fine
   * for a script, wrong here: every AI route caps at 30-60s of maxDuration and
   * reserves the user's rate-limit slot *before* the call, so a slow model
   * spent someone's hourly budget on a 504 they never saw an answer for.
   */
  it("fits the whole call, retries included, inside the shortest route deadline", () => {
    setAnthropicForTests(null);
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

    const client = getAnthropic();
    // The platform kills on wall time, so the budget that matters is every
    // attempt added up — a 25s timeout with one retry is 50s under a 30s
    // maxDuration, which is the 504-on-a-spent-reservation this is meant to
    // stop, not a fix for it.
    const worstCase = client.timeout * (1 + client.maxRetries);
    expect(worstCase).toBeLessThan(SHORTEST_AI_ROUTE_DEADLINE_MS);
    // And enough of that deadline is left to return a real error, not a 504.
    expect(SHORTEST_AI_ROUTE_DEADLINE_MS - worstCase).toBeGreaterThanOrEqual(2_000);

    setAnthropicForTests(null);
  });
});

describe("agentic turn budget", () => {
  /**
   * The per-call timeout bounds nothing on its own for a caller that loops:
   * runChat/runChatStream make up to seven model calls, which is 175s of
   * per-call budget under /api/chat's 60s maxDuration.
   */
  it("fits a whole tool loop inside the chat route's deadline", () => {
    const CHAT_ROUTE_DEADLINE_MS = 60_000;
    expect(AI_LOOP_BUDGET_MS).toBeLessThan(CHAT_ROUTE_DEADLINE_MS);
    // Room left to answer with what the loop already has, rather than being
    // killed mid-call and returning nothing for a spent rate-limit slot.
    expect(CHAT_ROUTE_DEADLINE_MS - AI_LOOP_BUDGET_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("hands each call what is left, never more than one call's worth", () => {
    const now = Date.now();
    expect(remainingBudget(now, AI_LOOP_BUDGET_MS)).toBe(25_000);
    // 40s in, only 10s of the shared budget remains — so that is the timeout.
    expect(remainingBudget(now - 40_000, AI_LOOP_BUDGET_MS)).toBeCloseTo(10_000, -2);
  });

  it("says stop rather than 'no limit' once the budget is spent", () => {
    const spent = Date.now() - (AI_LOOP_BUDGET_MS + 1_000);
    expect(remainingBudget(spent, AI_LOOP_BUDGET_MS)).toBeNull();
    // And with too little left to be worth starting another call.
    expect(remainingBudget(Date.now() - (AI_LOOP_BUDGET_MS - 500), AI_LOOP_BUDGET_MS)).toBeNull();
  });

  it("gives batch work off a route a budget of its own", () => {
    // `pnpm ingest enrich` batches 25 bottles at 8,000 tokens with search
    // continuations and answers to a job runner, not a platform deadline —
    // the route budget would abort perfectly good generations.
    expect(AI_BATCH_TIMEOUT_MS).toBeGreaterThan(SHORTEST_AI_ROUTE_DEADLINE_MS);
  });
});
