import { vi, type Mock } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Test-only fake Anthropic client. Scripted responses are returned by
 * messages.create in order; running out of responses throws so tests fail
 * loudly instead of looping.
 */

export interface FakeAnthropic {
  client: Anthropic;
  create: Mock;
}

export function makeFakeAnthropic(responses: Array<Record<string, unknown>>): FakeAnthropic {
  const queue = [...responses];
  const create = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("FakeAnthropic: no more scripted responses");
    return next;
  });
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}

let counter = 0;

/** Build a scripted assistant message whose content is plain text. */
export function textResponse(text: string, stopReason = "end_turn"): Record<string, unknown> {
  counter += 1;
  return {
    id: `msg_fake_${counter}`,
    type: "message",
    role: "assistant",
    model: "fake-model",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "text", text }],
  };
}

/** Build a scripted assistant message that requests a tool call. */
export function toolUseResponse(
  name: string,
  input: unknown,
  opts?: { id?: string; leadText?: string },
): Record<string, unknown> {
  counter += 1;
  const content: Array<Record<string, unknown>> = [];
  if (opts?.leadText) content.push({ type: "text", text: opts.leadText });
  content.push({ type: "tool_use", id: opts?.id ?? `toolu_fake_${counter}`, name, input });
  return {
    id: `msg_fake_${counter}`,
    type: "message",
    role: "assistant",
    model: "fake-model",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    content,
  };
}
