import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb } from "@/test/helpers";
import {
  MODEL_RATES_USD_PER_MTOK,
  aiCostSince,
  meanAiCostPerActiveUser,
  recordAiUsage,
  usdForTokens,
} from "./usage";

let db: DB;
beforeEach(async () => {
  db = await setupTestDb();
});

describe("what a model call cost", () => {
  it("stores the token counts the response reported", async () => {
    const user = await createTestUser(db);
    await recordAiUsage(db, {
      userId: user.id,
      feature: "chat",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 10,
      },
    });
    const [row] = await db.select().from(schema.aiUsage);
    expect(row.inputTokens).toBe(1000);
    expect(row.outputTokens).toBe(200);
    // Cache reads bill at a fraction of input, so they are kept apart rather
    // than folded in — added to inputTokens the estimate would be ~10x high.
    expect(row.cachedInputTokens).toBe(5000);
    expect(row.cacheWriteTokens).toBe(10);
  });

  it("records nothing when the response reported no usage", async () => {
    const user = await createTestUser(db);
    await recordAiUsage(db, { userId: user.id, feature: "chat", model: "m", usage: null });
    // A row of zeroes would read as "this call was free" rather than "we did
    // not learn what it cost", and would drag every mean toward zero.
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
  });

  it("accepts a system call with no user behind it", async () => {
    await recordAiUsage(db, {
      userId: null,
      feature: "enrich",
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const [row] = await db.select().from(schema.aiUsage);
    expect(row.userId).toBeNull();
  });

  it("never throws, so telemetry cannot fail the call it describes", async () => {
    // A user id that violates the foreign key: the insert fails and the caller
    // must not hear about it — the user already has their answer.
    await expect(
      recordAiUsage(db, {
        userId: "nobody",
        feature: "chat",
        model: "m",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("converting tokens to money at read time", () => {
  it("prices each token class at its own rate", () => {
    const usd = usdForTokens("claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(usd).toBeCloseTo(MODEL_RATES_USD_PER_MTOK["claude-sonnet-5"].input, 6);
  });

  it("matches a dated model id to its family by prefix", () => {
    // Deployed ids carry date suffixes; the rate table should not have to
    // chase every one of them.
    expect(
      usdForTokens("claude-sonnet-5-20991231", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeCloseTo(MODEL_RATES_USD_PER_MTOK["claude-sonnet-5"].input, 6);
  });

  it("prices an unknown model at the most expensive rate, not at zero", () => {
    const unknown = usdForTokens("some-model-nobody-added", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    const dearest = Math.max(...Object.values(MODEL_RATES_USD_PER_MTOK).map((r) => r.output));
    // Failing free is how a budget alarm goes silent exactly when a new model
    // is rolled out, which is when it is most needed.
    expect(unknown).toBeCloseTo(dearest, 6);
    expect(unknown).toBeGreaterThan(0);
  });
});

describe("reading the cost back", () => {
  async function spend(userId: string | null, feature: schema.AiFeature, out: number) {
    await recordAiUsage(db, {
      userId,
      feature,
      model: "claude-sonnet-5",
      usage: { input_tokens: 100, output_tokens: out },
    });
  }

  it("splits by feature, because one number says nothing actionable", async () => {
    const user = await createTestUser(db);
    await spend(user.id, "chat", 5000);
    await spend(user.id, "chat", 1000);
    await spend(user.id, "pairings", 10);

    const rows = await aiCostSince(db, new Date(Date.now() - 60_000));
    const byFeature = Object.fromEntries(rows.map((r) => [r.feature, r]));
    expect(byFeature.chat.calls).toBe(2);
    expect(byFeature.chat.outputTokens).toBe(6000);
    expect(byFeature.pairings.outputTokens).toBe(10);
    // Ordered by spend, so the expensive one is the one you read first.
    expect(rows[0].feature).toBe("chat");
  });

  it("averages over accounts that used AI, not over everybody", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    await createTestUser(db); // never touches AI
    await spend(a.id, "chat", 1000);
    await spend(b.id, "chat", 1000);

    const { users, meanUsd, totalUsd } = await meanAiCostPerActiveUser(
      db,
      new Date(Date.now() - 60_000),
    );
    // Three accounts exist and two spent anything. Dividing by three would
    // make the figure fall as the app grew — the wrong direction for an alarm.
    expect(users).toBe(2);
    expect(meanUsd).toBeCloseTo(totalUsd / 2, 9);
  });

  it("leaves system spend out of the per-user mean", async () => {
    const user = await createTestUser(db);
    await spend(user.id, "chat", 1000);
    await spend(null, "enrich", 900_000);

    const { users } = await meanAiCostPerActiveUser(db, new Date(Date.now() - 60_000));
    expect(users).toBe(1);
    // But the total across features still sees it: nobody's bill, still a bill.
    const all = await aiCostSince(db, new Date(Date.now() - 60_000));
    expect(all.some((r) => r.feature === "enrich")).toBe(true);
  });
});
