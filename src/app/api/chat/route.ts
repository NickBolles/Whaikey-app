import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import { ChatSessionNotFoundError, getChatMessages, runChat } from "@/lib/ai/chat";

// Node runtime (not edge): this route uses the DB driver and the Anthropic SDK.
export const runtime = "nodejs";
// Concierge chat runs multi-step tool calls against Claude — allow headroom.
export const maxDuration = 60;

const postSchema = z.object({
  sessionId: z.string().min(1).nullish(),
  message: z.string().min(1).max(4000),
});

/** POST /api/chat {sessionId?, message} → {sessionId, message, toolCalls} */
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

    try {
      const result = await runChat(
        getDb(),
        user.id,
        parsed.data.sessionId ?? null,
        parsed.data.message,
      );
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof ChatSessionNotFoundError) {
        return NextResponse.json({ error: "Chat session not found" }, { status: 404 });
      }
      throw err;
    }
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
