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
  const create = vi.fn(async (params?: Record<string, unknown>) => {
    const next = queue.shift();
    if (!next) throw new Error("FakeAnthropic: no more scripted responses");
    // When the caller opts into streaming, reconstruct an Anthropic-style
    // event stream from the next scripted message; otherwise return it as-is.
    if (params?.stream) return toEventStream(next);
    return next;
  });
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}

/**
 * Reconstruct an Anthropic streaming event sequence from a scripted message
 * object (the same shape textResponse/toolUseResponse produce). The returned
 * value is a reusable async-iterable: each `for await` gets a fresh iterator.
 */
export function toEventStream(message: Record<string, unknown>): AsyncIterable<Record<string, unknown>> {
  const content = (message.content as Array<Record<string, unknown>>) ?? [];
  const stopReason = (message.stop_reason as string) ?? "end_turn";

  async function* gen(): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: "message_start",
      message: {
        id: message.id,
        type: "message",
        role: "assistant",
        model: message.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: message.usage ?? { input_tokens: 1, output_tokens: 0 },
      },
    };

    for (let index = 0; index < content.length; index++) {
      const block = content[index];
      if (block.type === "text") {
        yield { type: "content_block_start", index, content_block: { type: "text", text: "" } };
        yield {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        };
        yield { type: "content_block_stop", index };
      } else if (block.type === "tool_use") {
        yield {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        };
        yield {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
        };
        yield { type: "content_block_stop", index };
      }
    }

    yield { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } };
    yield { type: "message_stop" };
  }

  return { [Symbol.asyncIterator]: gen };
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
