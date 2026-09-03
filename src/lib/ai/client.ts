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
 * Budget for a single model call (REL-3.1).
 *
 * The SDK defaults to a ten-minute timeout and two retries, which is a fine
 * default for a script and a wrong one here: every AI route caps out at 30-60 s
 * of `maxDuration` and *reserves the user's rate-limit slot before the call*,
 * so a slow model spent someone's hourly budget on a 504 they never saw an
 * answer for. Twenty-five seconds leaves room inside the shortest of those
 * caps to fail and say so; one retry covers a dropped connection without
 * doubling the wait.
 */
const AI_TIMEOUT_MS = 25_000;
const AI_MAX_RETRIES = 1;

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
