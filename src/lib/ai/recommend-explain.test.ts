import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import type { Recommendation } from "@/lib/recommend";
import { attachAiExplanations } from "./recommend-explain";
import { setAnthropicForTests } from "./client";
import { makeFakeAnthropic, textResponse } from "./testing";

let db: DB;
let userId: string;
let bottleId: string;

beforeEach(async () => {
  db = await setupTestDb();
  setAnthropicForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  const user = await createTestUser(db);
  userId = user.id;
  const bottle = await createTestBottle(db);
  bottleId = bottle.id;
});

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    bottleId,
    name: "Test Bourbon 10",
    distillery: null,
    category: "bourbon",
    region: null,
    ageYears: 10,
    avgPrice: 60,
    matchPercent: 84,
    reason: "Deterministic reason.",
    ...overrides,
  };
}

describe("attachAiExplanations", () => {
  it("does not call AI for an empty rec list", async () => {
    const fake = makeFakeAnthropic([]);
    const result = await attachAiExplanations(db, userId, "discovery", [], fake.client);
    expect(result).toEqual([]);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("uses a cached rec_explanations row without calling AI", async () => {
    await db.insert(schema.recExplanations).values({
      id: uid("rec"),
      userId,
      bottleId,
      mode: "discovery",
      reason: "Cached: because you loved smoky drams.",
    });
    const fake = makeFakeAnthropic([]);
    const result = await attachAiExplanations(db, userId, "discovery", [makeRec()], fake.client);
    expect(result[0].reason).toBe("Cached: because you loved smoky drams.");
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("generates, persists a row, and uses the AI reason when the cache is empty", async () => {
    const fake = makeFakeAnthropic([
      textResponse(JSON.stringify({ reason: "A smoky match for your top-rated Islays." })),
    ]);
    const result = await attachAiExplanations(db, userId, "discovery", [makeRec()], fake.client);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(result[0].reason).toBe("A smoky match for your top-rated Islays.");

    const rows = await db
      .select()
      .from(schema.recExplanations)
      .where(and(eq(schema.recExplanations.userId, userId), eq(schema.recExplanations.mode, "discovery")));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("A smoky match for your top-rated Islays.");
  });

  it("keeps the deterministic reason when AI is not configured", async () => {
    const result = await attachAiExplanations(db, userId, "discovery", [makeRec()]);
    expect(result[0].reason).toBe("Deterministic reason.");
    const rows = await db.select().from(schema.recExplanations);
    expect(rows).toHaveLength(0);
  });

  it("falls back to the deterministic reason on AI failure without throwing", async () => {
    const fake = makeFakeAnthropic([]); // no scripted responses => create throws
    const result = await attachAiExplanations(db, userId, "discovery", [makeRec()], fake.client);
    expect(result[0].reason).toBe("Deterministic reason.");
    expect(fake.create).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(schema.recExplanations);
    expect(rows).toHaveLength(0);
  });
});
