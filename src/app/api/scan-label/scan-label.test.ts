import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as schema from "@/db/schema";
import type { DB } from "@/db";
import {
  createTestBottle,
  createTestUser,
  jsonRequest,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
} from "@/test/helpers";
import { setAnthropicForTests } from "@/lib/ai/client";
import { makeFakeAnthropic, textResponse } from "@/lib/ai/testing";
import { POST } from "./route";

vi.mock("@/lib/session", async () => mockSessionModule());

let db: DB;
let user: schema.User;

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUg=="; // tiny valid-looking base64 payload

beforeEach(async () => {
  db = setupTestDb();
  user = await createTestUser(db);
  setSessionUser(null);
  setAnthropicForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
});

describe("POST /api/scan-label", () => {
  it("returns 401 when signed out", async () => {
    const res = await POST(
      jsonRequest("/api/scan-label", "POST", { imageBase64: TINY_PNG, mediaType: "image/png" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when AI is not configured", async () => {
    setSessionUser(user);
    const res = await POST(
      jsonRequest("/api/scan-label", "POST", { imageBase64: TINY_PNG, mediaType: "image/png" }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("AI features are not configured");
  });

  it("returns 413 for an oversize payload without calling the model", async () => {
    setSessionUser(user);
    const fake = makeFakeAnthropic([]);
    setAnthropicForTests(fake.client);
    // ~7.1M base64 chars ≈ 5.3MB decoded > 5MB limit
    const huge = "a".repeat(7_100_000);
    const res = await POST(
      jsonRequest("/api/scan-label", "POST", { imageBase64: huge, mediaType: "image/jpeg" }),
    );
    expect(res.status).toBe(413);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("returns 400 for an unsupported media type", async () => {
    setSessionUser(user);
    setAnthropicForTests(makeFakeAnthropic([]).client);
    const res = await POST(
      jsonRequest("/api/scan-label", "POST", { imageBase64: TINY_PNG, mediaType: "image/tiff" }),
    );
    expect(res.status).toBe(400);
  });

  it("extracts label fields and matches catalog candidates", async () => {
    setSessionUser(user);
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    await createTestBottle(db, { name: "Completely Unrelated Rum" });

    const fake = makeFakeAnthropic([
      textResponse(
        JSON.stringify({
          brandGuess: "Eagle Rare",
          expressionGuess: "10 Year",
          ageStatement: "10 Year",
          proof: 90,
        }),
      ),
    ]);
    setAnthropicForTests(fake.client);

    const res = await POST(
      jsonRequest("/api/scan-label", "POST", { imageBase64: TINY_PNG, mediaType: "image/png" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extracted).toEqual({
      brandGuess: "Eagle Rare",
      expressionGuess: "10 Year",
      ageStatement: "10 Year",
      proof: 90,
    });
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates.length).toBeLessThanOrEqual(3);
    expect(body.candidates[0].id).toBe(bottle.id);

    // The vision request actually carried the image.
    const call = fake.create.mock.calls[0][0] as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(call.messages[0].content[0].type).toBe("image");
  });
});
