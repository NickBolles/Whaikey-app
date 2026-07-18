import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as schema from "@/db/schema";
import type { DB } from "@/db";
import {
  createTestUser,
  jsonRequest,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
} from "@/test/helpers";
import { setAnthropicForTests } from "@/lib/ai/client";
import { makeFakeAnthropic, textResponse, toolUseResponse } from "@/lib/ai/testing";
import { POST, GET } from "./route";
import { GET as getSessions } from "./sessions/route";

vi.mock("@/lib/session", async () => mockSessionModule());

let db: DB;
let user: schema.User;

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db);
  setSessionUser(null);
  setAnthropicForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

describe("POST /api/chat", () => {
  it("returns 401 when signed out", async () => {
    const res = await POST(jsonRequest("/api/chat", "POST", { message: "hi" }));
    expect(res.status).toBe(401);
  });

  it("returns 503 when AI is not configured", async () => {
    setSessionUser(user);
    const res = await POST(jsonRequest("/api/chat", "POST", { message: "hi" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("AI features are not configured");
  });

  it("returns 400 for an invalid body", async () => {
    setSessionUser(user);
    setAnthropicForTests(makeFakeAnthropic([]).client);
    const res = await POST(jsonRequest("/api/chat", "POST", { message: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown session id", async () => {
    setSessionUser(user);
    setAnthropicForTests(makeFakeAnthropic([textResponse("hi")]).client);
    const res = await POST(
      jsonRequest("/api/chat", "POST", { sessionId: "nope", message: "hello" }),
    );
    expect(res.status).toBe(404);
  });

  it("runs the chat loop on the happy path and persists the session", async () => {
    setSessionUser(user);
    const fake = makeFakeAnthropic([
      toolUseResponse("get_my_bar", {}),
      textResponse("Your bar is empty — time to go shopping."),
    ]);
    setAnthropicForTests(fake.client);

    const res = await POST(
      jsonRequest("/api/chat", "POST", { message: "What should I pour tonight?" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    expect(body.message).toContain("shopping");
    expect(body.toolCalls).toHaveLength(1);
    expect(body.toolCalls[0].name).toBe("get_my_bar");

    // Session list reflects the new chat.
    const sessionsRes = await getSessions();
    expect(sessionsRes.status).toBe(200);
    const sessionsBody = await sessionsRes.json();
    expect(sessionsBody.sessions).toHaveLength(1);
    expect(sessionsBody.sessions[0].title).toBe("What should I pour tonight?");

    // GET /api/chat?sessionId returns the thread.
    const messagesRes = await GET(
      jsonRequest(`/api/chat?sessionId=${body.sessionId}`, "GET"),
    );
    expect(messagesRes.status).toBe(200);
    const messagesBody = await messagesRes.json();
    expect(messagesBody.messages).toHaveLength(2);
    expect(messagesBody.messages[1].toolCalls).toHaveLength(1);
  });
});

describe("GET /api/chat", () => {
  it("401s when signed out and 400s without sessionId", async () => {
    const unauthed = await GET(jsonRequest("/api/chat?sessionId=x", "GET"));
    expect(unauthed.status).toBe(401);

    setSessionUser(user);
    const missingParam = await GET(jsonRequest("/api/chat", "GET"));
    expect(missingParam.status).toBe(400);
  });

  it("404s for another user's session", async () => {
    setSessionUser(user);
    setAnthropicForTests(makeFakeAnthropic([textResponse("hi")]).client);
    const created = await POST(jsonRequest("/api/chat", "POST", { message: "mine" }));
    const { sessionId } = await created.json();

    const other = await createTestUser(db);
    setSessionUser(other);
    const res = await GET(jsonRequest(`/api/chat?sessionId=${sessionId}`, "GET"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/chat/sessions", () => {
  it("returns 401 when signed out", async () => {
    const res = await getSessions();
    expect(res.status).toBe(401);
  });
});
