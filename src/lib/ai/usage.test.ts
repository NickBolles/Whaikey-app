import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb } from "@/test/helpers";
import {
  aiCostSince,
  isKnownModel,
  meanAiCostPerActiveUser,
  normalizeModelId,
  rateFor,
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
  it("prices each token class from the model's input rate", () => {
    const rate = rateFor("claude-sonnet-5");
    expect(
      usdForTokens("claude-sonnet-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeCloseTo(rate.input, 6);
    // Cache reads bill at a tenth of input, writes at 1.25x. Derived from the
    // input rate rather than listed separately, so a price correction cannot
    // update one and miss the others.
    expect(
      usdForTokens("claude-sonnet-5", {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 0,
      }),
    ).toBeCloseTo(rate.input * 0.1, 6);
  });

  it("normalises the OpenRouter ids this repo actually defaults to", () => {
    // AGENTS.md: OpenRouter is PREFERRED when its key is set, and
    // `chatModel()` / `fastModel()` then return these exact strings. Matched
    // raw, neither hits the table and ordinary traffic was priced at the
    // unknown-model fallback — a budget alarm reading several times high on
    // every default deployment.
    expect(normalizeModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("anthropic/claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(isKnownModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(isKnownModel("anthropic/claude-sonnet-4")).toBe(true);
    // And the first-party ids, which carry a date suffix.
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(isKnownModel("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("prices the OpenRouter id the same as its first-party twin", () => {
    const tokens = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(usdForTokens("anthropic/claude-haiku-4.5", tokens)).toBeCloseTo(
      usdForTokens("claude-haiku-4-5-20251001", tokens),
      9,
    );
  });

  it("does not let a shorter family name answer for a longer one", () => {
    // "claude-sonnet-4" is a prefix of "claude-sonnet-4-6"; longest match wins.
    expect(rateFor("claude-sonnet-4-6")).toEqual(rateFor("claude-sonnet-4-6"));
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("prices an unknown model at the dearest rate, not at zero", () => {
    const unknown = usdForTokens("some-model-nobody-added", {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    // Failing free is how a budget alarm goes silent exactly when a new model
    // is rolled out, which is when it is most needed.
    expect(unknown).toBeGreaterThan(0);
    expect(isKnownModel("some-model-nobody-added")).toBe(false);
    expect(unknown).toBeGreaterThanOrEqual(
      usdForTokens("claude-opus-5", {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
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
    // Ordered by spend, so the expensive one is the one you read first —
    // which only became true when the sort moved off output tokens; see below.
    expect(rows[0].feature).toBe("chat");
  });

  it("orders by what it costs, not by how many tokens came out", async () => {
    const user = await createTestUser(db);
    // The normal mix: chat on Sonnet ($2/$10 per Mtok), scanning on Haiku
    // ($1/$5). Haiku emits far MORE output tokens here and still costs less.
    await recordAiUsage(db, {
      userId: user.id,
      feature: "scan",
      model: "claude-haiku-4-5",
      usage: { input_tokens: 0, output_tokens: 100_000 }, // 100k x $5/Mtok = $0.50
    });
    await recordAiUsage(db, {
      userId: user.id,
      feature: "chat",
      model: "claude-sonnet-5",
      usage: { input_tokens: 0, output_tokens: 60_000 }, // 60k x $10/Mtok = $0.60
    });

    const rows = await aiCostSince(db, new Date(Date.now() - 60_000));
    // Sorting on output tokens put the scan row first and pointed the operator
    // at the cheaper feature — and ignored input and cache charges entirely,
    // which for a long-context feature are most of the bill.
    expect(rows[0].feature).toBe("chat");
    expect(rows[0].outputTokens).toBeLessThan(rows[1].outputTokens);
    expect(rows[0].estimatedUsd).toBeGreaterThan(rows[1].estimatedUsd);
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
