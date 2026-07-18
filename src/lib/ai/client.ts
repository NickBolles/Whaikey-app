import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic client factory for the AI gateway vertical.
 *
 * All Anthropic calls happen server-side through this module. Tests inject a
 * fake via setAnthropicForTests(); production code lazily builds a singleton
 * from ANTHROPIC_API_KEY. When no key is configured, API routes return a 503
 * and the UI renders a friendly setup note.
 */

let testClient: Anthropic | null = null;
let singleton: Anthropic | null = null;

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI features are not configured");
    this.name = "AiNotConfiguredError";
  }
}

/** True when either a test client is injected or an API key is present. */
export function isAiConfigured(): boolean {
  return testClient !== null || Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Singleton Anthropic client. Throws AiNotConfiguredError when no key is set. */
export function getAnthropic(): Anthropic {
  if (testClient) return testClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AiNotConfiguredError();
  if (!singleton) singleton = new Anthropic({ apiKey });
  return singleton;
}

/** Test seam: swap in a fake client (pass null to clear). Resets the singleton. */
export function setAnthropicForTests(client: Anthropic | null): void {
  testClient = client;
  singleton = null;
}

/** Model for chat + pairings. */
export function chatModel(): string {
  return process.env.WHAIKEY_CHAT_MODEL ?? "claude-sonnet-5";
}

/** Fast model for extraction + label scan. */
export function fastModel(): string {
  return process.env.WHAIKEY_FAST_MODEL ?? "claude-haiku-4-5-20251001";
}
