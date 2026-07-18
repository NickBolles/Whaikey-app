import { beforeEach, describe, expect, it } from "vitest";
import { eq, asc } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { runChat, getChatSessions, getChatMessages, ChatSessionNotFoundError } from "./chat";
import { makeFakeAnthropic, textResponse, toolUseResponse } from "./testing";

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

describe("getChatSessions / getChatMessages", () => {
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
