import type Anthropic from "@anthropic-ai/sdk";
import { activeAiProvider, getAnthropic } from "@/lib/ai/client";
import { textFromContent } from "@/lib/ai/json";

/**
 * Model providers for in-app enrichment (docs/DATA_SOURCES.md §2.4c).
 *
 * Server-side only, from Vercel functions, with an API key:
 *
 *   ENRICH_PROVIDER = openai | anthropic | auto (default auto: OpenAI when
 *                     OPENAI_API_KEY is set, else Anthropic when
 *                     the shared AI client talks to Anthropic directly —
 *                     ANTHROPIC_API_KEY set and no OpenRouter key, because
 *                     OpenRouter does not run Anthropic's hosted web search)
 *   ENRICH_ENABLED  = "true" to let anything call a model. Default off, so a
 *                     deployment that merely HAS a key (ANTHROPIC_API_KEY is
 *                     already set for chat) spends nothing until the owner
 *                     opts in.
 *
 * Models (overridable): OpenAI quick `gpt-6-luna`, web `gpt-6.1-sol` with the
 * hosted `web_search` tool; Anthropic quick `claude-haiku-4-5`, web
 * `claude-sonnet-5` with hosted web search. The owner's ChatGPT/Codex login is
 * not an API key and cannot be used from here.
 */

export type EnrichProviderName = "openai" | "anthropic";

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  webSearches: number;
}

export interface CompleteInput {
  prompt: string;
  model: string;
  web: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  /** Hosted searches the model may run (web only). */
  maxSearches?: number;
}

export interface CompleteResult {
  text: string;
  usage: CallUsage;
}

export interface EnrichProvider {
  name: EnrichProviderName;
  quickModel: string;
  webModel: string;
  complete(input: CompleteInput): Promise<CompleteResult>;
}

export class ProviderCallError extends Error {
  constructor(
    message: string,
    readonly usage: CallUsage | null = null,
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}

const ZERO: CallUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, webSearches: 0 };

// ---------------------------------------------------------------------------
// OpenAI (Responses API over fetch — no SDK dependency)
// ---------------------------------------------------------------------------

interface OpenAiResponse {
  status?: string;
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string } | null;
}

export function openAiProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EnrichProvider {
  const reasoning = process.env.ENRICH_OPENAI_REASONING ?? "low";
  return {
    name: "openai",
    quickModel: process.env.ENRICH_OPENAI_QUICK_MODEL || "gpt-6-luna",
    webModel: process.env.ENRICH_OPENAI_WEB_MODEL || "gpt-6.1-sol",
    async complete(input) {
      const body: Record<string, unknown> = {
        model: input.model,
        input: input.prompt,
        max_output_tokens: input.maxOutputTokens,
        store: false,
      };
      if (reasoning !== "none") body.reasoning = { effort: reasoning };
      if (input.web) {
        body.tools = [{ type: "web_search" }];
        body.max_tool_calls = input.maxSearches ?? 3;
      }
      const res = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as OpenAiResponse;
      const usage: CallUsage = {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cachedInputTokens: json.usage?.input_tokens_details?.cached_tokens ?? 0,
        webSearches: (json.output ?? []).filter((o) => o.type === "web_search_call").length,
      };
      // Cached tokens are a subset of input tokens on OpenAI; keep them apart
      // so pricing doesn't bill them twice.
      usage.inputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
      if (!res.ok) throw new ProviderCallError(`openai ${res.status}: ${json.error?.message?.slice(0, 200) ?? "error"}`, usage);
      const text = (json.output ?? [])
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      return { text, usage };
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic, through the shared client seam (src/lib/ai/client.ts: gateway
// config + setAnthropicForTests). Each request passes its own step-sized
// timeout, overriding the client's route-sized default.
// ---------------------------------------------------------------------------

export function anthropicProvider(client?: Anthropic): EnrichProvider {
  const anthropic = client ?? getAnthropic();
  return {
    name: "anthropic",
    quickModel: process.env.ENRICH_ANTHROPIC_QUICK_MODEL || "claude-haiku-4-5",
    webModel: process.env.ENRICH_ANTHROPIC_WEB_MODEL || "claude-sonnet-5",
    async complete(input) {
      const usage: CallUsage = { ...ZERO };
      const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [{ role: "user", content: input.prompt }];
      const texts: string[] = [];
      const started = Date.now();
      try {
        // Hosted search runs a server-side loop that can pause; resume it a
        // couple of times within the step's budget.
        // Continuations share ONE output/search allowance with the first
        // request, so a resumed turn can't spend past what the hold priced.
        for (let turn = 0; turn < 3; turn++) {
          const left = input.timeoutMs - (Date.now() - started);
          if (left < 2_000) break;
          const outputLeft = input.maxOutputTokens - usage.outputTokens;
          if (outputLeft < 200) break;
          const searchesLeft = (input.maxSearches ?? 3) - usage.webSearches;
          const response = await anthropic.messages.create(
            {
              model: input.model,
              max_tokens: outputLeft,
              messages,
              ...(input.web && searchesLeft > 0
                ? { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: searchesLeft }] }
                : {}),
            } as never,
            { timeout: left, maxRetries: 0 },
          );
          const u = response.usage as {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number | null;
            server_tool_use?: { web_search_requests?: number | null } | null;
          };
          usage.inputTokens += u?.input_tokens ?? 0;
          usage.outputTokens += u?.output_tokens ?? 0;
          usage.cachedInputTokens += u?.cache_read_input_tokens ?? 0;
          usage.webSearches += u?.server_tool_use?.web_search_requests ?? 0;
          texts.push(textFromContent(response.content as never));
          if (response.stop_reason !== "pause_turn") break;
          messages.push({ role: "assistant", content: response.content });
        }
      } catch (err) {
        throw new ProviderCallError(`anthropic: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`, usage);
      }
      return { text: texts.join("\n"), usage };
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let testProvider: EnrichProvider | null | undefined;

/** Test seam (pass undefined to restore env-based selection). */
export function setEnrichProviderForTests(provider: EnrichProvider | null | undefined): void {
  testProvider = provider;
}

/** Which provider the env selects, without constructing it. */
export function selectedProviderName(): EnrichProviderName | null {
  if (testProvider !== undefined) return testProvider?.name ?? null;
  const pref = (process.env.ENRICH_PROVIDER ?? "auto").toLowerCase();
  const hasOpenAi = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = activeAiProvider() === "anthropic";
  if (pref === "openai") return hasOpenAi ? "openai" : null;
  if (pref === "anthropic") return hasAnthropic ? "anthropic" : null;
  if (hasOpenAi) return "openai";
  if (hasAnthropic) return "anthropic";
  return null;
}

export function getEnrichProvider(): EnrichProvider | null {
  if (testProvider !== undefined) return testProvider;
  const name = selectedProviderName();
  if (name === "openai") return openAiProvider(process.env.OPENAI_API_KEY as string);
  if (name === "anthropic") return anthropicProvider();
  return null;
}

/** The env switch. Off unless explicitly "true". */
export function enrichEnabledByEnv(): boolean {
  return (process.env.ENRICH_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Model calls are possible: switched on AND a provider key is present. */
export function enrichLive(): boolean {
  return enrichEnabledByEnv() && getEnrichProvider() != null;
}
