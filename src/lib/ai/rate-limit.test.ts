import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb } from "@/test/helpers";
import { AI_DAILY_LIMIT, AI_HOURLY_LIMIT, reserveAiRequest } from "./rate-limit";

let db: DB;
let userId: string;

beforeEach(async () => {
  db = await setupTestDb();
  userId = (await createTestUser(db)).id;
});

describe("reserveAiRequest", () => {
  it("enforces the approved 20/hour durable limit without over-consuming a rejected request", async () => {
    const now = new Date("2026-07-25T12:34:56.000Z");
    await Promise.all(Array.from({ length: AI_HOURLY_LIMIT }, () => reserveAiRequest(db, userId, now)));
    expect(await reserveAiRequest(db, userId, now)).toBe(false);
    const rows = await db.select().from(schema.aiRateLimits);
    expect(rows.find((row) => row.window === "hour")?.count).toBe(AI_HOURLY_LIMIT);
    expect(rows.find((row) => row.window === "day")?.count).toBe(AI_HOURLY_LIMIT);
  });

  it("allows a new hour but stops at the approved 100/day limit", async () => {
    const day = new Date("2026-07-25T00:00:00.000Z");
    for (let hour = 0; hour < 5; hour += 1) {
      const now = new Date(day.getTime() + hour * 60 * 60 * 1000);
      for (let request = 0; request < AI_HOURLY_LIMIT; request += 1) {
        expect(await reserveAiRequest(db, userId, now)).toBe(true);
      }
    }
    expect(AI_DAILY_LIMIT).toBe(100);
    expect(await reserveAiRequest(db, userId, new Date("2026-07-25T05:00:00.000Z"))).toBe(false);
  });
});