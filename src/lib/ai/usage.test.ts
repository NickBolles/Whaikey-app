import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  setRateTableForTests,
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

  it("records nothing for an all-zero reading, which means unknown and not free", async () => {
    const user = await createTestUser(db);
    /**
     * `makeClaudeCodeClient` fabricates `{ input_tokens: 0, output_tokens: 0 }`
     * because the CLI does not surface a meter on that path. Storing it made
     * the operator report claim a paid AI surface was free — worse than a gap,
     * because a blank invites the question and a zero answers it wrongly.
     */
    await recordAiUsage(db, {
      userId: user.id,
      feature: "enrich",
      model: "claude-sonnet-5",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);

    // A cache-only read is still a real, billable reading and must survive.
    await recordAiUsage(db, {
      userId: user.id,
      feature: "chat",
      model: "claude-sonnet-5",
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 400 },
    });
    expect(await db.select().from(schema.aiUsage)).toHaveLength(1);
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

  it("does not let an unpriced version inherit an older family's cheaper rate", () => {
    // A prefix match answered `claude-sonnet-4-7` with `claude-sonnet-4`'s
    // $3/$15. That is the one direction this table must never fail in: an
    // unknown model is priced at the TOP of the range precisely so a cost
    // alarm cries wolf rather than sleeping through a model that costs more
    // than the last one. `-4-6` already having its own row is the proof that
    // point releases really do get their own prices.
    const dearest = rateFor("something-nobody-has-priced");
    expect(rateFor("claude-sonnet-4-7")).toEqual(dearest);
    expect(rateFor("anthropic/claude-sonnet-4.7")).toEqual(dearest);
    expect(isKnownModel("claude-sonnet-4-7")).toBe(false);
  });

  it("still prices a dated snapshot as the family it pins", () => {
    // A snapshot is the same model with a pin, not a new one.
    expect(rateFor("claude-sonnet-4-20250514")).toEqual(rateFor("claude-sonnet-4"));
    expect(isKnownModel("claude-sonnet-4-20250514")).toBe(true);
    // And the exact ids keep working, including the OpenRouter spellings.
    expect(rateFor("claude-sonnet-4-6")).toEqual({ input: 3, output: 15 });
    expect(rateFor("anthropic/claude-haiku-4.5")).toEqual({ input: 1, output: 5 });
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


describe("a price change must not rewrite what past months cost", () => {
  /**
   * A table where Sonnet doubled on 2026-06-01 and a dearer model appeared on
   * the same day. Every entry in the real table shares one effective date
   * because no price has changed yet, so the behaviour that matters — what
   * happens the day one does — has no fixture without this.
   */
  const CHANGED = {
    "claude-sonnet-5": [
      { from: "1970-01-01", input: 2, output: 10 },
      { from: "2026-06-01", input: 4, output: 20 },
    ],
    "claude-opus-5": [{ from: "2026-06-01", input: 5, output: 25 }],
  };

  const BEFORE = new Date("2026-05-20T12:00:00.000Z");
  const AFTER = new Date("2026-06-20T12:00:00.000Z");

  beforeEach(() => setRateTableForTests(CHANGED));
  afterEach(() => setRateTableForTests());

  async function spendOn(userId: string | null, at: Date, model: string, out: number) {
    await db.insert(schema.aiUsage).values({
      id: crypto.randomUUID(),
      userId,
      feature: "chat",
      model,
      inputTokens: 0,
      outputTokens: out,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      createdAt: at,
    });
  }

  it("prices a call at the rate in effect when it was made", () => {
    expect(rateFor("claude-sonnet-5", BEFORE)).toEqual({ input: 2, output: 10 });
    expect(rateFor("claude-sonnet-5", AFTER)).toEqual({ input: 4, output: 20 });
  });

  it("charges an unknown model the dearest rate THAT EXISTED THEN", () => {
    // Opus arrives on 2026-06-01. Before that the dearest thing in the table
    // is Sonnet at $10/Mtok out; pricing a May call at Opus's $25 would move a
    // figure that has already been reported, because the table grew.
    expect(rateFor("model-nobody-priced", BEFORE)).toEqual({ input: 2, output: 10 });
    expect(rateFor("model-nobody-priced", AFTER)).toEqual({ input: 5, output: 25 });
  });

  it("sums each UTC day of a report at that day's rate", async () => {
    const user = await createTestUser(db);
    await spendOn(user.id, BEFORE, "claude-sonnet-5", 1_000_000);
    await spendOn(user.id, AFTER, "claude-sonnet-5", 1_000_000);

    const [row] = await aiCostSince(db, new Date("2026-01-01T00:00:00.000Z"));
    // $10 at May's rate plus $20 at June's. Priced at today's rate throughout
    // it would read $40 — a report headed "since January" quoting a price that
    // did not apply for half of it.
    expect(row.estimatedUsd).toBeCloseTo(30, 9);
    // And the days fold back into ONE row per feature+model: the day decides
    // the price, it is not a dimension of the answer.
    expect(row.calls).toBe(2);
    expect(row.outputTokens).toBe(2_000_000);
  });

  it("prices the per-user mean by day too", async () => {
    const user = await createTestUser(db);
    await spendOn(user.id, BEFORE, "claude-sonnet-5", 1_000_000);
    await spendOn(user.id, AFTER, "claude-sonnet-5", 1_000_000);
    // Nobody's request: still excluded from both halves of a per-user figure.
    await spendOn(null, AFTER, "claude-sonnet-5", 5_000_000);

    const { users, totalUsd, meanUsd } = await meanAiCostPerActiveUser(
      db,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(users).toBe(1);
    expect(totalUsd).toBeCloseTo(30, 9);
    expect(meanUsd).toBeCloseTo(30, 9);
  });

  it("counts distinct spenders without reading a row per account", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    await spendOn(a.id, AFTER, "claude-sonnet-5", 1_000_000);
    await spendOn(a.id, AFTER, "claude-opus-5", 1_000_000);
    await spendOn(b.id, AFTER, "claude-sonnet-5", 1_000_000);

    const { users, totalUsd } = await meanAiCostPerActiveUser(
      db,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    // Two accounts, three rows, two models: the count is of people, not rows.
    expect(users).toBe(2);
    expect(totalUsd).toBeCloseTo(20 + 25 + 20, 9);
  });
});
