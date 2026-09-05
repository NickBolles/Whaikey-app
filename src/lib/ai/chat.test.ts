import { beforeEach, describe, expect, it } from "vitest";
import { eq, asc } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  runChat,
  runChatStream,
  getChatSessions,
  getChatMessages,
  ChatSessionNotFoundError,
  boundChatHistory,
  MAX_CHAT_CONTEXT_CHARS,
  type ChatStreamEvent,
} from "./chat";
import { makeFakeAnthropic, textResponse, toolUseResponse } from "./testing";
import type Anthropic from "@anthropic-ai/sdk";

async function drain(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

let db: DB;
let user: schema.User;

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db);
});

describe("runChat", () => {
  it("executes tools, persists messages with toolCalls, and creates a titled session", async () => {
    const bottle = await createTestBottle(db, { name: "Test Bourbon 10" });
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: bottle.id,
      relationship: "own",
    });

    const fake = makeFakeAnthropic([
      toolUseResponse("get_my_bar", {}, { id: "toolu_1", leadText: "Let me check your bar." }),
      textResponse("Based on your bar, pour the Test Bourbon 10 tonight."),
    ]);

    const result = await runChat(db, user.id, null, "What should I pour tonight?", {
      client: fake.client,
    });

    // Two model calls: tool round + final answer.
    expect(fake.create).toHaveBeenCalledTimes(2);

    // The second call fed the tool_result (containing real DB data) back.
    const secondCall = fake.create.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolResultMsg = secondCall.messages.at(-1) as {
      role: string;
      content: Array<{ type: string; tool_use_id: string; content: string }>;
    };
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].tool_use_id).toBe("toolu_1");
    expect(toolResultMsg.content[0].content).toContain("Test Bourbon 10");

    // Return value.
    expect(result.message).toContain("Test Bourbon 10");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_my_bar");

    // Session created with the message as title.
    const sessions = await getChatSessions(db, user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(result.sessionId);
    expect(sessions[0].title).toBe("What should I pour tonight?");

    // Messages persisted: user + assistant with toolCalls trace.
    const messages = await db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.sessionId, result.sessionId))
      .orderBy(asc(schema.chatMessages.createdAt));
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("What should I pour tonight?");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].toolCalls).toHaveLength(1);
    expect(messages[1].toolCalls?.[0].name).toBe("get_my_bar");
  });

  it("truncates the session title to 60 characters", async () => {
    const fake = makeFakeAnthropic([textResponse("Short answer.")]);
    const longMessage = "x".repeat(100);
    const result = await runChat(db, user.id, null, longMessage, { client: fake.client });
    const sessions = await getChatSessions(db, user.id);
    expect(sessions[0].id).toBe(result.sessionId);
    expect(sessions[0].title).toHaveLength(60);
  });

  it("continues an existing session and includes prior history in the model call", async () => {
    const fake1 = makeFakeAnthropic([textResponse("Hello! Ask me anything about whiskey.")]);
    const first = await runChat(db, user.id, null, "Hi there", { client: fake1.client });

    const fake2 = makeFakeAnthropic([textResponse("Sherry casks add dried fruit notes.")]);
    const second = await runChat(db, user.id, first.sessionId, "Explain sherry casks", {
      client: fake2.client,
    });

    expect(second.sessionId).toBe(first.sessionId);
    const call = fake2.create.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // history (user + assistant) + new user message
    expect(call.messages).toHaveLength(3);
    expect(call.messages[0]).toEqual({ role: "user", content: "Hi there" });
    expect(call.messages[1].role).toBe("assistant");

    const messages = await getChatMessages(db, user.id, first.sessionId);
    expect(messages).toHaveLength(4);
  });

  it("throws ChatSessionNotFoundError for another user's session", async () => {
    const other = await createTestUser(db);
    const fake = makeFakeAnthropic([textResponse("hi")]);
    const theirs = await runChat(db, other.id, null, "their chat", { client: fake.client });

    const fake2 = makeFakeAnthropic([textResponse("hi")]);
    await expect(
      runChat(db, user.id, theirs.sessionId, "sneaky", { client: fake2.client }),
    ).rejects.toThrow(ChatSessionNotFoundError);
  });

  it("stops after the max tool iteration budget", async () => {
    // Model asks for a tool every time; loop must cut off.
    const responses = Array.from({ length: 10 }, () => toolUseResponse("get_my_bar", {}));
    const fake = makeFakeAnthropic(responses);
    const result = await runChat(db, user.id, null, "loop forever", {
      client: fake.client,
      maxIterations: 2,
    });
    // iterations 0 and 1 execute tools; iteration 2 breaks without executing.
    expect(result.toolCalls).toHaveLength(2);
    expect(fake.create).toHaveBeenCalledTimes(3);
    // Fallback text is persisted even though the model never produced a final answer.
    const messages = await getChatMessages(db, user.id, result.sessionId);
    expect(messages?.at(-1)?.role).toBe("assistant");
    expect(messages?.at(-1)?.content).toBeTruthy();
  });
});

describe("runChatStream cost accounting when the stream does not finish", () => {
  /**
   * A client whose stream reports its usage and then dies. `message_start`
   * carries the input and cache counts, which Anthropic bills whether or not
   * anyone reads the answer, so this is the shape where the meter reading was
   * being thrown away.
   */
  function dyingStreamClient(): Anthropic {
    const create = async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "message_start",
          message: {
            id: "msg_dead",
            model: "claude-sonnet-5",
            usage: { input_tokens: 900, output_tokens: 0, cache_read_input_tokens: 100 },
          },
        };
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Half a" } };
        throw new Error("upstream stream died");
      },
    });
    return { messages: { create } } as unknown as Anthropic;
  }

  it("records the tokens already billed when the stream errors mid-flight", async () => {
    await expect(
      drain(runChatStream(db, user.id, null, "What should I pour?", { client: dyingStreamClient() })),
    ).rejects.toThrow(/upstream stream died/);

    const rows = await db.select().from(schema.aiUsage);
    // Recorded despite the abnormal exit. Before the `finally`, the write sat
    // after the loop, so exactly the calls that failed were the ones missing
    // from the totals — the direction that flatters the number.
    expect(rows).toHaveLength(1);
    expect(rows[0].feature).toBe("chat");
    expect(rows[0].userId).toBe(user.id);
    expect(rows[0].inputTokens).toBe(900);
    expect(rows[0].cachedInputTokens).toBe(100);
  });

  it("records nothing when the stream dies before reporting any usage", async () => {
    const create = async () => ({
      async *[Symbol.asyncIterator]() {
        throw new Error("connection refused");
        // eslint-disable-next-line no-unreachable
        yield {} as never;
      },
    });
    const client = { messages: { create } } as unknown as Anthropic;

    await expect(
      drain(runChatStream(db, user.id, null, "hi", { client })),
    ).rejects.toThrow(/connection refused/);

    // Nothing billable happened, so a zero row would be noise in the
    // per-feature totals rather than a truer number.
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
  });
});

describe("runChatStream", () => {
  it("streams text, dispatches tools, and persists like runChat", async () => {
    const bottle = await createTestBottle(db, { name: "Test Bourbon 10" });
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: bottle.id,
      relationship: "own",
    });

    const fake = makeFakeAnthropic([
      toolUseResponse("get_my_bar", {}, { id: "toolu_1", leadText: "Let me check your bar." }),
      textResponse("Based on your bar, pour the Test Bourbon 10 tonight."),
    ]);

    const events = await drain(
      runChatStream(db, user.id, null, "What should I pour tonight?", { client: fake.client }),
    );

    // Two streamed model calls (tool round + final answer).
    expect(fake.create).toHaveBeenCalledTimes(2);
    // Both were streaming calls.
    expect((fake.create.mock.calls[0][0] as { stream?: boolean }).stream).toBe(true);

    // The second call fed the tool_result (with real DB data) back.
    const secondCall = fake.create.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolResultMsg = secondCall.messages.at(-1) as {
      role: string;
      content: Array<{ type: string; tool_use_id: string; content: string }>;
    };
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].tool_use_id).toBe("toolu_1");
    expect(toolResultMsg.content[0].content).toContain("Test Bourbon 10");

    // session event emitted first.
    expect(events[0]).toMatchObject({ type: "session" });
    const sessionId = (events[0] as { sessionId: string }).sessionId;

    // A tool event announced the dispatch.
    const toolEvent = events.find((e) => e.type === "tool");
    expect(toolEvent).toMatchObject({ type: "tool", name: "get_my_bar" });

    // done event carries the final message + tool trace.
    const done = events.find((e) => e.type === "done") as Extract<
      ChatStreamEvent,
      { type: "done" }
    >;
    expect(done.sessionId).toBe(sessionId);
    expect(done.message).toContain("Test Bourbon 10");
    expect(done.toolCalls).toHaveLength(1);
    expect(done.toolCalls[0].name).toBe("get_my_bar");

    // Streamed text deltas assemble to include the final answer.
    const streamed = events
      .filter((e): e is Extract<ChatStreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.text)
      .join("");
    expect(streamed).toContain("Test Bourbon 10 tonight.");

    // Persistence matches runChat: user + assistant(with toolCalls).
    const messages = await getChatMessages(db, user.id, sessionId);
    expect(messages).toHaveLength(2);
    expect(messages?.[0].role).toBe("user");
    expect(messages?.[0].content).toBe("What should I pour tonight?");
    expect(messages?.[1].role).toBe("assistant");
    expect(messages?.[1].content).toBe(done.message);
    expect(messages?.[1].toolCalls).toHaveLength(1);
    expect(messages?.[1].toolCalls?.[0].name).toBe("get_my_bar");

    // Session titled from the first message.
    const sessions = await getChatSessions(db, user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].title).toBe("What should I pour tonight?");
  });

  it("throws ChatSessionNotFoundError before yielding for another user's session", async () => {
    const other = await createTestUser(db);
    const theirs = await runChat(db, other.id, null, "their chat", {
      client: makeFakeAnthropic([textResponse("hi")]).client,
    });

    const gen = runChatStream(db, user.id, theirs.sessionId, "sneaky", {
      client: makeFakeAnthropic([textResponse("hi")]).client,
    });
    // Error surfaces on the first advance, before any event is yielded.
    await expect(gen.next()).rejects.toThrow(ChatSessionNotFoundError);
  });

  it("persists fallback text when the model never produces a final answer", async () => {
    const responses = Array.from({ length: 10 }, () => toolUseResponse("get_my_bar", {}));
    const fake = makeFakeAnthropic(responses);
    const events = await drain(
      runChatStream(db, user.id, null, "loop forever", { client: fake.client, maxIterations: 2 }),
    );
    const done = events.find((e) => e.type === "done") as Extract<
      ChatStreamEvent,
      { type: "done" }
    >;
    expect(done.toolCalls).toHaveLength(2);
    expect(fake.create).toHaveBeenCalledTimes(3);
    expect(done.message).toBeTruthy();
    const messages = await getChatMessages(db, user.id, done.sessionId);
    expect(messages?.at(-1)?.role).toBe("assistant");
    expect(messages?.at(-1)?.content).toBe(done.message);
  });
});

describe("getChatSessions / getChatMessages", () => {
  it("bounds model history to recent turns and a 12k text budget", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: String(i), sessionId: "s", role: i % 2 ? "assistant" : "user", content: "x".repeat(1_000),
      toolCalls: null, createdAt: new Date(),
    })) as schema.ChatMessage[];
    const bounded = boundChatHistory(messages);
    expect(bounded.length).toBeLessThanOrEqual(24);
    expect(bounded.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(MAX_CHAT_CONTEXT_CHARS);
    expect(bounded.at(-1)?.id).toBe("29");
  });

  it("counts persisted tool-result payloads against the model context budget", () => {
    const messages = [
      { id: "old", sessionId: "s", role: "assistant", content: "short", toolCalls: [{ name: "get_my_bar", input: {}, result: "x".repeat(12_000) }], createdAt: new Date() },
      { id: "new", sessionId: "s", role: "user", content: "newest request", toolCalls: null, createdAt: new Date() },
    ] as schema.ChatMessage[];
    expect(boundChatHistory(messages).map((message) => message.id)).toEqual(["new"]);
  });

  it("scopes sessions and messages to the user", async () => {
    const other = await createTestUser(db);
    const fake = makeFakeAnthropic([textResponse("a"), textResponse("b")]);
    const mine = await runChat(db, user.id, null, "mine", { client: fake.client });
    const theirs = await runChat(db, other.id, null, "theirs", { client: fake.client });

    const sessions = await getChatSessions(db, user.id);
    expect(sessions.map((s) => s.id)).toEqual([mine.sessionId]);

    expect(await getChatMessages(db, user.id, theirs.sessionId)).toBeNull();
    expect(await getChatMessages(db, user.id, mine.sessionId)).toHaveLength(2);
  });
});
