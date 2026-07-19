import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import type { ChatStreamEvent } from "@/lib/ai/chat";
import { ChatSessionNotFoundError, getChatMessages, runChatStream } from "@/lib/ai/chat";

// Node runtime (not edge): this route uses the DB driver and the Anthropic SDK.
export const runtime = "nodejs";
// Concierge chat runs multi-step tool calls against Claude — allow headroom.
export const maxDuration = 60;

const postSchema = z.object({
  sessionId: z.string().min(1).nullish(),
  message: z.string().min(1).max(4000),
});

/**
 * POST /api/chat {sessionId?, message} → text/event-stream of JSON events:
 *   data: {"type":"session","sessionId"}      (once, when the id is known)
 *   data: {"type":"text","text"}              (per streamed token delta)
 *   data: {"type":"tool","name"}              (when a tool is dispatched)
 *   data: {"type":"done","sessionId","message","toolCalls"}   (final)
 */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    if (!isAiConfigured()) {
      return NextResponse.json({ error: "AI features are not configured" }, { status: 503 });
    }

    const body = await request.json().catch(() => null);
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "A non-empty message is required" }, { status: 400 });
    }

    const generator = runChatStream(
      getDb(),
      user.id,
      parsed.data.sessionId ?? null,
      parsed.data.message,
    );

    // Advance once up front: session resolution (and its ChatSessionNotFoundError)
    // happens before the first yield, so a bad sessionId returns a real JSON 404
    // instead of a 200 stream.
    let first: IteratorResult<ChatStreamEvent>;
    try {
      first = await generator.next();
    } catch (err) {
      if (err instanceof ChatSessionNotFoundError) {
        return NextResponse.json({ error: "Chat session not found" }, { status: 404 });
      }
      throw err;
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        try {
          if (!first.done) send(first.value);
          for await (const event of generator) send(event);
        } catch (err) {
          console.error(err);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });
}

/** GET /api/chat?sessionId=... → {messages} for one of the user's sessions */
export async function GET(request: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }
    const messages = await getChatMessages(getDb(), user.id, sessionId);
    if (messages === null) {
      return NextResponse.json({ error: "Chat session not found" }, { status: 404 });
    }
    return NextResponse.json({ messages });
  });
}
