import { execFile } from "node:child_process";
import type Anthropic from "@anthropic-ai/sdk";
import { WEDGE_IDS } from "@/lib/flavor-wheel";

/**
 * A minimal Anthropic-Messages-compatible client backed by the local Claude
 * Code CLI (`claude -p`) instead of an API key.
 *
 * It exists so `enrichBottleProfiles` (src/lib/ingest/enrich.ts) can run
 * through an authenticated Claude Code *subscription* — every other concern of
 * enrichment (candidate selection, community-note roll-ups, validation,
 * idempotent writes, reporting) stays byte-for-byte identical because this
 * client is injected via the existing `EnrichOptions.client` seam.
 *
 * How it maps onto the Messages API surface enrich.ts actually touches:
 *   - `messages.create({ model, messages })` shells out to
 *       claude -p --output-format json --json-schema <schema> \
 *              --no-session-persistence
 *     feeding the user prompt directly. The configured Claude Code model is
 *     used unless the operator deliberately supplies an override.
 *   - `--json-schema` forces the model to return exactly the profile array
 *     enrich.ts expects; the CLI surfaces it as `structured_output`.
 *   - We stringify that structured output back into a single text content
 *     block, which is precisely what `textFromContent` + `parseModelJson`
 *     consume. `stop_reason` is always "end_turn": no tools ⇒ no server-tool
 *     `pause_turn` loop to resume.
 *
 * No API key, no session on disk, and no tools — just the local subscription.
 */

/** Per-batch wall-clock ceiling for a single `claude -p` invocation. */
const CLAUDE_TIMEOUT_MS = 180_000;

/** stdout can be large for big batches; lift the default 1 MiB exec buffer. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * The exact JSON Schema handed to `claude --json-schema`: an array with one
 * entry per input bottle, each an { id, profile } where profile carries all 8
 * flavor-wheel wedges as integers 0-10. Keyed off WEDGE_IDS so it can never
 * drift from the taxonomy contract.
 */
export function buildProfileArraySchema(): Record<string, unknown> {
  const profileProperties: Record<string, unknown> = {};
  for (const wedge of WEDGE_IDS) {
    profileProperties[wedge] = { type: "integer", minimum: 0, maximum: 10 };
  }
  return {
    type: "object",
    properties: {
      profiles: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            profile: {
              type: "object",
              properties: profileProperties,
              required: [...WEDGE_IDS],
              additionalProperties: false,
            },
          },
          required: ["id", "profile"],
          additionalProperties: false,
        },
      },
    },
    required: ["profiles"],
    additionalProperties: false,
  };
}

/**
 * Assemble the `claude` CLI arguments (everything after the executable name)
 * for one structured-output batch. Pure so it can be asserted directly.
 *
 *   -p                       print mode (non-interactive)
 *   --output-format json     single JSON result object on stdout
 *   --json-schema <schema>   validate/shape the result as the profile array
 *   --no-session-persistence never write a resumable session to disk
 *   --tools <list>            expose only WebSearch/WebFetch when requested
 *   --model <model>           optional operator-selected CLI model override
 */
export function buildClaudeArgs(opts: { model?: string; schema: Record<string, unknown>; allowWebSearch?: boolean }): string[] {
  const args = [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(opts.schema), "--no-session-persistence",
    "--tools", opts.allowWebSearch ? "WebSearch,WebFetch" : "",
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--disable-slash-commands",
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/**
 * Extract the single user prompt from the Messages payload enrich.ts builds.
 * enrich.ts only ever sends `[{ role: "user", content: <string> }]` (the web
 * search `pause_turn` resume path is unreachable here — we run with no tools),
 * so we concatenate the text of every user turn defensively.
 */
export function promptFromMessages(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
  }
  const prompt = parts.join("\n").trim();
  if (!prompt) throw new Error("claude-code client: no user prompt to send");
  return prompt;
}

export class ClaudeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

/**
 * Parse the JSON object printed by `claude -p --output-format json` and return
 * its `structured_output` re-serialized as text — exactly the string
 * `parseModelJson` expects to find the profile array in. Throws ClaudeCliError
 * with a descriptive message on any malformed / errored result so a bad batch
 * surfaces loudly instead of silently enriching nothing.
 */
export function structuredOutputText(stdout: string): string {
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    const preview = stdout.trim().slice(0, 200);
    throw new ClaudeCliError(`claude -p did not return JSON (got: ${preview || "<empty>"})`);
  }
  if (typeof result !== "object" || result === null) {
    throw new ClaudeCliError("claude -p JSON result was not an object");
  }
  const record = result as Record<string, unknown>;
  if (record.is_error === true) {
    const detail = typeof record.result === "string" ? record.result : record.subtype;
    throw new ClaudeCliError(`claude -p reported an error: ${detail ?? "unknown"}`);
  }
  if (!("structured_output" in record)) {
    throw new ClaudeCliError(
      "claude -p result had no structured_output (was --json-schema accepted?)",
    );
  }
  const structured = record.structured_output;
  const profiles = structured && typeof structured === "object" && "profiles" in structured
    ? (structured as { profiles: unknown }).profiles
    : structured;
  return JSON.stringify(profiles);
}

/** Promisified `claude -p` runner. Send prompts over stdin to avoid positional-argument failures for structured prompts. */
function runClaude(args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      args,
      { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          const detail = stderr?.trim() || stdout?.trim() || err.message;
          reject(new ClaudeCliError(`claude -p failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(prompt);
  });
}

export async function runClaudeStructured(options: {
  prompt: string;
  schema: Record<string, unknown>;
  model?: string;
  allowWebSearch?: boolean;
}): Promise<unknown> {
  const stdout = await runClaude(
    buildClaudeArgs({ schema: options.schema, model: options.model, allowWebSearch: options.allowWebSearch }),
    options.prompt,
  );
  return JSON.parse(structuredOutputText(stdout));
}

export interface ClaudeCodeClientOptions {
  /** Optional operator-selected model; omit to use the authenticated CLI default. */
  model?: string;
  /** Override the CLI runner (test seam). Defaults to spawning `claude -p`. */
  run?: (args: string[], prompt: string) => Promise<string>;
}

/**
 * Build an Anthropic-compatible client whose `messages.create` proxies to the
 * local Claude Code CLI. Injected into `enrichBottleProfiles({ client })`.
 */
export function makeClaudeCodeClient(options: ClaudeCodeClientOptions = {}): Anthropic {
  const run = options.run ?? runClaude;
  const schema = buildProfileArraySchema();

  const create = async (params: {
    model: string;
    max_tokens?: number;
    messages: Array<{ role: string; content: unknown }>;
  }) => {
    const prompt = promptFromMessages(params.messages);
    const stdout = await run(buildClaudeArgs({ model: options.model, schema }), prompt);
    const text = structuredOutputText(stdout);
    return {
      id: "claude-code",
      type: "message",
      role: "assistant",
      model: params.model,
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };

  // Only the messages.create surface enrich.ts uses is implemented.
  return { messages: { create } } as unknown as Anthropic;
}
