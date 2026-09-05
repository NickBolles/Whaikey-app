import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { reportInBackground } from "@/lib/observability/errors";
import { isAiConfigured } from "@/lib/ai/client";
import { reserveAiRequest } from "@/lib/ai/rate-limit";
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
    if (!(await reserveAiRequest(getDb(), user.id))) {
      return NextResponse.json({ error: "AI request limit reached. Try again later." }, { status: 429 });
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
    /**
     * Set when the CONSUMER goes away — a closed tab, a navigation, a client
     * abort — as opposed to the answer failing.
     *
     * Without this the two are indistinguishable from inside `start`: a
     * cancelled stream closes the controller, so the next `enqueue` throws and
     * lands in the same catch as a genuine Anthropic or database failure. The
     * report added for those would then have filed every routine navigation as
     * a chat error, which is how a monitoring signal becomes noise and then
     * becomes ignored — the failure this work package exists to prevent,
     * arriving through its own fix.
     */
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        try {
          if (!first.done) send(first.value);
          for await (const event of generator) send(event);
        } catch (err) {
          if (cancelled) {
            // Nobody is listening and nothing went wrong. Not reported, and
            // not sent: enqueueing into a closed controller throws again, and
            // a throw from this catch escapes `start` as an unhandled
            // rejection.
            return;
          }
          console.error("chat stream failed", err instanceof Error ? err.name : "unknown error");
          /**
           * Reported here, because nothing else can see it.
           *
           * `withErrorHandling` returned the moment this `Response` was
           * constructed, and `onRequestError` only sees what escapes to Next —
           * so an Anthropic failure, a tool failure or a database failure
           * *mid-stream* was swallowed into an SSE event and reported nowhere.
           * Chat is the highest-volume AI surface, so this was the largest
           * blind spot left in the monitoring: the user is told the concierge
           * could not finish, and the server said nothing at all.
           *
           * Same shape as the native sign-in handlers: a catch that answers
           * the client instead of rethrowing is invisible to every wrapper
           * above it, and has to report for itself.
           */
          reportInBackground(err, { where: "api/chat/stream", userId: user.id });
          try {
            send({ type: "error", message: "The concierge couldn't finish that response. Please try again." });
          } catch {
            // The client left between the failure and this line. The report
            // above is the part that matters; there is nobody to tell.
          }
        } finally {
          try {
            controller.close();
          } catch {
            // Already closed by a cancel. Closing twice is a TypeError, and
            // one thrown here would escape `start` unhandled.
          }
        }
      },
      cancel() {
        cancelled = true;
        // Stop the model call rather than letting it run on for a reader who
        // has gone: the generator's `finally` still records the tokens already
        // billed (see `runChatStream`).
        void generator.return(undefined as never);
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
