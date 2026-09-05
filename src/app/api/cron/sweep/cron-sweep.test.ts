import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb, uid } from "@/test/helpers";
import { RATE_LIMIT_RETENTION_MS } from "@/lib/ai/rate-limit";
import { submitBottle } from "@/lib/catalog";
import { GET } from "./route";
import { setErrorReporterForTests, type CapturedEvent } from "@/lib/observability/errors";
import * as socialModule from "@/lib/social";

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

  /**
   * The one thing here that is not a counter or a token. `bottles.submittedBy`
   * is `set null`, so an unapproved bottle survives its submitter's account
   * visible to nobody and reviewable by nobody — user-entered content
   * outliving the account it belongs to.
   */
  it("also sweeps unapproved bottles whose submitter's account is gone", async () => {
    const { bottle } = await submitBottle(db, user.id, {
      name: "Gone With Their Account",
      category: "bourbon",
    });
    await db.delete(schema.user).where(eq(schema.user.id, user.id));

    expect((await GET(get("Bearer test-secret"))).status).toBe(200);
    expect(
      await db.query.bottles.findFirst({ where: eq(schema.bottles.id, bottle.id) }),
    ).toBeUndefined();
  });

  it("deletes sessions whose expiry has passed, and keeps live ones", async () => {
    // Better Auth stops honouring an expired row; nothing deleted it, so a
    // device that goes quiet left its bearer token, IP address and user agent
    // behind for good — which /privacy says does not happen.
    const expired = uid("session");
    const live = uid("session");
    await db.insert(schema.session).values({
      id: expired,
      token: "expired-token",
      userId: user.id,
      ipAddress: "203.0.113.7",
      userAgent: "a browser",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await db.insert(schema.session).values({
      id: live,
      token: "live-token",
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    expect((await GET(get("Bearer test-secret"))).status).toBe(200);

    const rows = await db.select().from(schema.session);
    expect(rows.map((r) => r.id)).toEqual([live]);
  });

  it("clears provider tokens written after the one-time migration ran", async () => {
    // scripts/build.mjs applies migrations before the build that activates
    // encryptOAuthTokens, so a sign-in served by the old deployment during
    // that window writes plaintext the migration will never see again.
    await db.insert(schema.account).values({
      id: uid("account"),
      accountId: "google-1",
      providerId: "google",
      userId: user.id,
      accessToken: "written-during-rollout",
      idToken: "written-during-rollout",
    });

    expect((await GET(get("Bearer test-secret"))).status).toBe(200);

    const [row] = await db.select().from(schema.account);
    expect(row.accessToken).toBeNull();
    expect(row.idToken).toBeNull();
    // The link that signs the user in survives; only the tokens go.
    expect(row.accountId).toBe("google-1");
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


describe("one broken sweeper must not stop the rest", () => {
  let db: DB;
  const original = process.env.CRON_SECRET;
  let captured: CapturedEvent[];

  beforeEach(async () => {
    db = await setupTestDb();
    process.env.CRON_SECRET = "test-secret";
    captured = [];
    setErrorReporterForTests((e) => captured.push(e));
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
    setErrorReporterForTests(null);
    vi.restoreAllMocks();
  });

  function authed(): Request {
    return new Request("http://localhost/api/cron/sweep", {
      headers: { authorization: "Bearer test-secret" },
    });
  }

  it("still prunes telemetry when an earlier sweeper throws", async () => {
    // Phone lookups run BEFORE telemetry. As a straight line of awaits, this
    // ended the request and the 90-day telemetry retention silently stopped
    // being enforced -- for as long as the unrelated table stayed broken.
    vi.spyOn(socialModule, "sweepExpiredPhoneLookups").mockRejectedValue(
      new Error("phone_lookups is gone"),
    );
    const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    await db.insert(schema.aiUsage).values({
      id: uid("usage"),
      userId: null,
      feature: "enrich",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 1,
      createdAt: stale,
    });
    await db.insert(schema.analyticsEvents).values({
      id: uid("event"),
      name: "share_view",
      createdAt: stale,
    });

    const res = await GET(authed());

    // The row past its retention is gone even though an earlier task failed.
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
    expect(await db.select().from(schema.analyticsEvents)).toHaveLength(0);
    // And the failure is neither hidden nor mistaken for a clean run.
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, failed: ["phone-lookups"] });
    expect(captured.map((e) => e.context.tags?.task)).toContain("phone-lookups");
  });

  it("reports each broken task separately, not once for the run", async () => {
    vi.spyOn(socialModule, "sweepExpiredPhoneLookups").mockRejectedValue(new Error("a"));
    const catalog = await import("@/lib/catalog");
    vi.spyOn(catalog, "sweepOrphanedSubmissions").mockRejectedValue(new Error("b"));

    const res = await GET(authed());

    // Two different tables, two different root causes, two different fixes:
    // one event for the run would hide the second behind the first.
    expect(await res.json()).toEqual({
      ok: false,
      failed: ["phone-lookups", "orphaned-submissions"],
    });
    expect(captured.map((e) => e.context.tags?.task).sort()).toEqual([
      "orphaned-submissions",
      "phone-lookups",
    ]);
  });
});
