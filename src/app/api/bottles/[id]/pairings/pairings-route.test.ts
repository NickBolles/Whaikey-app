import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { setAnthropicForTests } from "@/lib/ai/client";
import { AI_HOURLY_LIMIT } from "@/lib/ai/rate-limit";
import { makeFakeAnthropic, textResponse } from "@/lib/ai/testing";
import {
  createTestBottle,
  createTestUser,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
  uid,
} from "@/test/helpers";
import { GET } from "./route";

// Route-level tests for GET /api/bottles/[id]/pairings (review REL-8.3): the
// lease, the wait and the 429 as the handler composes them. The generation
// lease itself is unit-tested in src/lib/ai/pairings.test.ts; what is asserted
// here is what only the route decides — who may trigger paid generation, when
// the AI budget is spent, and what a waiter sees.

vi.mock("@/lib/session", async () => mockSessionModule());

let db: DB;

const GENERATED = JSON.stringify([
  { pairingType: "food", suggestion: "Dark chocolate", rationale: "Echoes the oak" },
  { pairingType: "food", suggestion: "Smoked brisket", rationale: "Char meets char" },
  { pairingType: "cocktail", suggestion: "Old Fashioned", rationale: "Sweet enough to stir" },
]);

beforeEach(async () => {
  db = await setupTestDb();
  setSessionUser(null);
  setAnthropicForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  setAnthropicForTests(null);
});

function get(id: string) {
  return GET(new Request(`http://localhost:3000/api/bottles/${id}/pairings`), {
    params: Promise.resolve({ id }),
  });
}

async function cachePairing(bottleId: string, suggestion = "Grilled peaches") {
  await db.insert(schema.pairings).values({
    id: uid("pair"),
    bottleId,
    pairingType: "food",
    suggestion,
    rationale: "Fruit meets caramel",
    source: "ai",
  });
}

async function reservations(userId: string) {
  return db.select().from(schema.aiRateLimits).where(eq(schema.aiRateLimits.userId, userId));
}

describe("GET /api/bottles/[id]/pairings — cache hits are free", () => {
  it("serves cached pairings to a signed-out visitor without touching the model", async () => {
    const bottle = await createTestBottle(db);
    await cachePairing(bottle.id);
    const fake = makeFakeAnthropic([]);
    setAnthropicForTests(fake.client);

    const res = await get(bottle.id);
    expect(res.status).toBe(200);
    expect((await res.json()).pairings.map((p: { suggestion: string }) => p.suggestion)).toEqual([
      "Grilled peaches",
    ]);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("does not spend a signed-in user's AI budget on a cache hit", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    await cachePairing(bottle.id);

    expect((await get(bottle.id)).status).toBe(200);
    expect(await reservations(user.id)).toHaveLength(0);
  });
});

describe("GET /api/bottles/[id]/pairings — a cache miss is paid work", () => {
  it("401s a signed-out cache miss and never calls the model", async () => {
    const bottle = await createTestBottle(db);
    const fake = makeFakeAnthropic([textResponse(GENERATED)]);
    setAnthropicForTests(fake.client);

    expect((await get(bottle.id)).status).toBe(401);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("403s a signed-in user who has not passed the age gate", async () => {
    const user = await createTestUser(db, { ageVerified: false });
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    const fake = makeFakeAnthropic([textResponse(GENERATED)]);
    setAnthropicForTests(fake.client);

    expect((await get(bottle.id)).status).toBe(403);
    expect(fake.create).not.toHaveBeenCalled();
  });

  it("generates once for a signed-in user, charges one reservation, and attributes the cost", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    const fake = makeFakeAnthropic([textResponse(GENERATED)]);
    setAnthropicForTests(fake.client);

    const res = await get(bottle.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pairings).toHaveLength(3);
    expect(fake.create).toHaveBeenCalledOnce();

    const counters = await reservations(user.id);
    expect(counters.map((c) => [c.window, c.count]).sort()).toEqual([
      ["day", 1],
      ["hour", 1],
    ]);
    const usage = await db.select().from(schema.aiUsage).where(eq(schema.aiUsage.feature, "pairings"));
    expect(usage).toHaveLength(1);
    expect(usage[0].userId).toBe(user.id);

    // The lease is released after generation, and the next caller — even a
    // signed-out one — is served from the cache.
    expect(await db.select().from(schema.pairingGenerationLocks)).toHaveLength(0);
    setSessionUser(null);
    const again = await get(bottle.id);
    expect(again.status).toBe(200);
    expect((await again.json()).pairings).toHaveLength(3);
    expect(fake.create).toHaveBeenCalledOnce();
  });

  it("429s once the hourly budget is spent, without calling the model or taking the lease", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    const fake = makeFakeAnthropic([textResponse(GENERATED)]);
    setAnthropicForTests(fake.client);

    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    await db
      .insert(schema.aiRateLimits)
      .values({ userId: user.id, window: "hour", windowStart: hour, count: AI_HOURLY_LIMIT });

    const res = await get(bottle.id);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/limit/i);
    expect(fake.create).not.toHaveBeenCalled();
    expect(await db.select().from(schema.pairingGenerationLocks)).toHaveLength(0);
    expect(await db.select().from(schema.pairings)).toHaveLength(0);
    // The rejected request did not leak into the daily window either.
    const day = (await reservations(user.id)).find((c) => c.window === "day");
    expect(day).toBeUndefined();
  });

  it("serves a waiter the holder's pairings when another request holds a live lease", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    const fake = makeFakeAnthropic([textResponse(GENERATED)]);
    setAnthropicForTests(fake.client);

    // Another instance is mid-generation: it holds the lease and commits its
    // rows a moment after this request starts waiting.
    await db.insert(schema.pairingGenerationLocks).values({
      bottleId: bottle.id,
      token: "someone-else",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const holder = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        cachePairing(bottle.id, "From the holder").then(resolve, reject);
      }, 150);
    });

    const res = await get(bottle.id);
    await holder;
    expect(res.status).toBe(200);
    expect((await res.json()).pairings.map((p: { suggestion: string }) => p.suggestion)).toEqual([
      "From the holder",
    ]);
    // The waiter did not generate a second, competing set.
    expect(fake.create).not.toHaveBeenCalled();
    expect(await db.select().from(schema.pairings)).toHaveLength(1);
  });

  it("takes over an expired lease a crashed holder left behind", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    const bottle = await createTestBottle(db);
    const fake = makeFakeAnthropic([textResponse(GENERATED)]);
    setAnthropicForTests(fake.client);
    await db.insert(schema.pairingGenerationLocks).values({
      bottleId: bottle.id,
      token: "crashed",
      expiresAt: new Date(Date.now() - 1_000),
    });

    const res = await get(bottle.id);
    expect(res.status).toBe(200);
    expect((await res.json()).pairings).toHaveLength(3);
    expect(fake.create).toHaveBeenCalledOnce();
    expect(await db.select().from(schema.pairingGenerationLocks)).toHaveLength(0);
  });

  it("returns an empty list, not an error, when AI is not configured", async () => {
    const user = await createTestUser(db);
    setSessionUser(user);
    const bottle = await createTestBottle(db);

    const res = await get(bottle.id);
    expect(res.status).toBe(200);
    expect((await res.json()).pairings).toEqual([]);
    expect(await db.select().from(schema.pairings)).toHaveLength(0);
  });
});

describe("GET /api/bottles/[id]/pairings — visibility", () => {
  it("404s an unknown bottle", async () => {
    expect((await get("no-such-bottle")).status).toBe(404);
  });

  it("404s somebody else's pending submission, even with pairings cached", async () => {
    const owner = await createTestUser(db);
    const viewer = await createTestUser(db);
    const bottle = await createTestBottle(db, { status: "user_submitted", submittedBy: owner.id });
    await cachePairing(bottle.id);

    setSessionUser(null);
    expect((await get(bottle.id)).status).toBe(404);
    setSessionUser(viewer);
    expect((await get(bottle.id)).status).toBe(404);
    setSessionUser(owner);
    expect((await get(bottle.id)).status).toBe(200);
  });
});
