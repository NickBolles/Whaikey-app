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
import { AI_HOURLY_LIMIT, reserveAiRequest } from "@/lib/ai/rate-limit";
import { makeFakeAnthropic } from "@/lib/ai/testing";
import { POST } from "./route";

vi.mock("@/lib/session", async () => mockSessionModule());

let db: DB;
let user: schema.User;

beforeEach(async () => {
  db = await setupTestDb();
  user = await createTestUser(db);
  setSessionUser(user);
  setAnthropicForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

describe("POST /api/extract-note", () => {
  it("returns 429 before calling the model when AI quota is exhausted", async () => {
    const fake = makeFakeAnthropic([]);
    setAnthropicForTests(fake.client);
    for (let i = 0; i < AI_HOURLY_LIMIT; i += 1) await reserveAiRequest(db, user.id);

    const res = await POST(jsonRequest("/api/extract-note", "POST", { text: "Vanilla and oak" }));

    expect(res.status).toBe(429);
    expect(fake.create).not.toHaveBeenCalled();
  });
});