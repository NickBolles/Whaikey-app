import { randomUUID } from "node:crypto";
import { asc, desc, eq, and } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { chatModel, getAnthropic } from "./client";
import { executeTool, TOOL_DEFINITIONS } from "./tools";

/** Max number of tool-executing iterations per user turn. */
const MAX_TOOL_ITERATIONS = 6;

export class ChatSessionNotFoundError extends Error {
  constructor() {
    super("Chat session not found");
    this.name = "ChatSessionNotFoundError";
  }
}

const SYSTEM_PROMPT = `You are Whaikey's whiskey concierge — a knowledgeable, friendly guide to whiskey and to the user's own collection.

Grounding rules:
- Use the provided tools to ground answers in the user's actual data (their bar, pour history, tasting notes) and the bottle catalog. When you used tool data, briefly cite it, e.g. "based on your pour history" or "from your bar".
- Never invent prices or availability. Only cite prices that appear in bottle records (msrp / average price), and say when you don't know.
- If a tool returns an error, work with what you have or ask the user to clarify.

Write actions:
- add_to_wishlist changes the user's data. Only call it when the user's message clearly requests it (e.g. "add X to my wishlist", "save that one"). Never call it speculatively. After a write, confirm in plain text exactly what you did.

Responsible drinking:
- Never encourage the user to drink more or more often; keep recommendations about quality and enjoyment, not quantity.
- Make no health claims about alcohol.
- Where relevant, keep a brief "enjoy responsibly" stance.
- Refuse age-inappropriate contexts: if anything suggests the user is underage or is asking for help with underage drinking, decline politely.

Style: concise and warm. Lead with the answer, then supporting detail.`;

export interface ChatToolCall {
  name: string;
  input: unknown;
  result?: unknown;
}

export interface RunChatResult {
  sessionId: string;
  message: string;
  toolCalls: ChatToolCall[];
}

interface RunChatOpts {
  client?: Anthropic;
  maxIterations?: number;
}

/**
 * Run one user turn of the concierge chat: create the session if needed,
 * persist the user message, run the agentic tool loop, persist the assistant
 * reply (with tool-call trace), and return the result.
 */
export async function runChat(
  db: DB,
  userId: string,
  sessionId: string | null,
  userMessage: string,
  opts?: RunChatOpts,
): Promise<RunChatResult> {
  const anthropic = opts?.client ?? getAnthropic();
  const maxIterations = opts?.maxIterations ?? MAX_TOOL_ITERATIONS;
  const trimmed = userMessage.trim();

  // Resolve or create the session.
  let session: schema.ChatSession;
  if (sessionId) {
    const [existing] = await db
      .select()
      .from(schema.chatSessions)
      .where(and(eq(schema.chatSessions.id, sessionId), eq(schema.chatSessions.userId, userId)))
      .limit(1);
    if (!existing) throw new ChatSessionNotFoundError();
    session = existing;
  } else {
    const [created] = await db
      .insert(schema.chatSessions)
      .values({ id: randomUUID(), userId, title: trimmed.slice(0, 60) })
      .returning();
    session = created;
  }

  // Prior history for model context (text only; tool traces are display-only).
  const history = await db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, session.id))
    .orderBy(asc(schema.chatMessages.createdAt));

  // Persist the user message.
  await db.insert(schema.chatMessages).values({
    id: randomUUID(),
    sessionId: session.id,
    role: "user",
    content: trimmed,
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: trimmed },
  ];

  const toolCalls: ChatToolCall[] = [];
  let finalText = "";

  for (let iteration = 0; ; iteration++) {
    const response = await anthropic.messages.create({
      model: chatModel(),
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    const content = response.content as Anthropic.Messages.ContentBlock[];
    const texts = content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text",
    );
    if (texts.length > 0) finalText = texts.map((b) => b.text).join("\n");

    const toolUses = content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (response.stop_reason !== "tool_use" || toolUses.length === 0 || iteration >= maxIterations) {
      break;
    }

    messages.push({ role: "assistant", content });
    const results: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const result = await executeTool(db, userId, toolUse.name, toolUse.input);
      toolCalls.push({ name: toolUse.name, input: toolUse.input, result });
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: results });
  }

  if (!finalText) {
    finalText = "Sorry — I couldn't finish that request. Could you rephrase it?";
  }

  await db.insert(schema.chatMessages).values({
    id: randomUUID(),
    sessionId: session.id,
    role: "assistant",
    content: finalText,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  });

  await db
    .update(schema.chatSessions)
    .set({ updatedAt: new Date() })
    .where(eq(schema.chatSessions.id, session.id));

  return { sessionId: session.id, message: finalText, toolCalls };
}

/** List the user's chat sessions, most recently active first. */
export async function getChatSessions(db: DB, userId: string): Promise<schema.ChatSession[]> {
  return db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.userId, userId))
    .orderBy(desc(schema.chatSessions.updatedAt));
}

/** Messages for one of the user's sessions (oldest first), or null if not theirs. */
export async function getChatMessages(
  db: DB,
  userId: string,
  sessionId: string,
): Promise<schema.ChatMessage[] | null> {
  const [session] = await db
    .select()
    .from(schema.chatSessions)
    .where(and(eq(schema.chatSessions.id, sessionId), eq(schema.chatSessions.userId, userId)))
    .limit(1);
  if (!session) return null;
  return db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(asc(schema.chatMessages.createdAt));
}
