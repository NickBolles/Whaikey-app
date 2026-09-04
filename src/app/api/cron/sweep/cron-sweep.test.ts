import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb, uid } from "@/test/helpers";
import { RATE_LIMIT_RETENTION_MS } from "@/lib/ai/rate-limit";
import { GET } from "./route";

/**
 * The retention claim in `/privacy` used to hold only while somebody was using
 * the AI features, because the sweep rode along on `reserveAiRequest`. A
 * dormant account kept its counters indefinitely.
 */
describe("GET /api/cron/sweep", () => {
  let db: DB;
  let user: schema.User;
  const original = process.env.CRON_SECRET;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db);
    process.env.CRON_SECRET = "test-secret";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  function get(auth?: string): Request {
    return new Request("http://localhost/api/cron/sweep", {
      headers: auth ? { authorization: auth } : {},
    });
  }

  async function seedStaleCounter() {
    await db.insert(schema.aiRateLimits).values({
      userId: user.id,
      window: "hour",
      windowStart: new Date(Date.now() - RATE_LIMIT_RETENTION_MS - 60_000),
      count: 3,
    });
  }

  it("drops counters whose window closed long ago", async () => {
    await seedStaleCounter();
    expect(await db.select().from(schema.aiRateLimits)).toHaveLength(1);

    expect((await GET(get("Bearer test-secret"))).status).toBe(200);
    expect(await db.select().from(schema.aiRateLimits)).toHaveLength(0);
  });

  it("leaves a counter whose window is still being counted against", async () => {
    await db.insert(schema.aiRateLimits).values({
      userId: user.id,
      window: "hour",
      windowStart: new Date(),
      count: 1,
    });
    expect((await GET(get("Bearer test-secret"))).status).toBe(200);
    expect(await db.select().from(schema.aiRateLimits)).toHaveLength(1);
  });

  /**
   * `/privacy` names three things it prunes, and the first version of this
   * route swept one of them — the same mistake the route exists to fix,
   * surviving its own fix. Native codes matter most: they hold encrypted
   * session cookies.
   */
  it("sweeps every table the retention promise names", async () => {
    await seedStaleCounter();
    await db.insert(schema.nativeAuthCodes).values({
      id: uid("code"),
      userId: user.id,
      codeHash: "stale",
      sessionCookieName: "s",
      sessionCookie: "encrypted",
      codeChallenge: "c",
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await db.insert(schema.nativeAuthRequests).values({
      id: uid("req"),
      codeChallenge: "c",
      state: "s",
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await db.insert(schema.phoneLookups).values({
      id: uid("probe"),
      userId: user.id,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    expect((await GET(get("Bearer test-secret"))).status).toBe(200);

    expect(await db.select().from(schema.aiRateLimits)).toHaveLength(0);
    expect(await db.select().from(schema.nativeAuthCodes)).toHaveLength(0);
    expect(await db.select().from(schema.nativeAuthRequests)).toHaveLength(0);
    expect(await db.select().from(schema.phoneLookups)).toHaveLength(0);
  });

  it("is 404 without the secret, and 404 when none is configured", async () => {
    await seedStaleCounter();
    expect((await GET(get())).status).toBe(404);
    expect((await GET(get("Bearer wrong"))).status).toBe(404);

    // Unset grants nobody rather than everybody: this route runs deletes.
    delete process.env.CRON_SECRET;
    expect((await GET(get("Bearer test-secret"))).status).toBe(404);

    // Nothing was swept by any of those.
    expect(await db.select().from(schema.aiRateLimits)).toHaveLength(1);
  });
});
