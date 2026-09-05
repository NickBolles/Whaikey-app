import { beforeEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type { DB } from "@/db";
import { aiUsage, bottleClaims, bottleResources, bottles, catalogSources, pours, tastingNotes } from "@/db/schema";
import { makeFakeAnthropic } from "@/lib/ai/testing";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  buildEnrichPrompt,
  cleanProfile,
  enrichBottleProfiles,
  enrichModel,
  profileFromNotes,
} from "./enrich";

const fullProfile = (over: Record<string, number> = {}) => ({
  fruity: 3,
  floral: 1,
  grain: 4,
  sweet: 6,
  woody: 5,
  spicy: 3,
  peaty: 0,
  feinty: 1,
  ...over,
});

const textResponse = (payload: unknown, stopReason = "end_turn") => ({
  id: "msg_test",
  content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
  stop_reason: stopReason,
});

async function addNote(
  db: DB,
  userId: string,
  bottleId: string,
  flavorTags: Record<string, number> | null,
  text: Partial<{ nose: string; palate: string; finish: string }> = {},
): Promise<void> {
  const pourId = uid("pour");
  await db.insert(pours).values({ id: pourId, userId, bottleId, rating: 4 });
  await db.insert(tastingNotes).values({
    id: uid("note"),
    pourId,
    flavorTags,
    nose: text.nose ?? null,
    palate: text.palate ?? null,
    finish: text.finish ?? null,
  });
}

describe("cleanProfile", () => {
  it("accepts full profiles and clamps out-of-range scores", () => {
    expect(cleanProfile(fullProfile({ sweet: 14, peaty: -2 }))).toMatchObject({
      sweet: 10,
      peaty: 0,
    });
  });

  it("rejects incomplete, non-numeric, and all-zero profiles", () => {
    const missing: Partial<ReturnType<typeof fullProfile>> = fullProfile();
    delete missing.sweet;
    expect(cleanProfile(missing)).toBeNull();
    expect(cleanProfile(fullProfile({ woody: "oak" as unknown as number }))).toBeNull();
    expect(cleanProfile(Object.fromEntries(Object.keys(fullProfile()).map((k) => [k, 0])))).toBeNull();
    expect(cleanProfile(null)).toBeNull();
  });

});

describe("profileFromNotes", () => {
  it("rolls tagged notes up to a full 8-wedge profile", () => {
    const profile = profileFromNotes([
      { flavorTags: { vanilla: 3, "green-apple": 1 }, nose: null, palate: null, finish: null },
      { flavorTags: { vanilla: 2 }, nose: null, palate: null, finish: null },
    ]);
    expect(profile).not.toBeNull();
    expect(Object.keys(profile!).sort()).toEqual(
      ["feinty", "floral", "fruity", "grain", "peaty", "spicy", "sweet", "woody"].sort(),
    );
    expect(profile!.sweet).toBeGreaterThan(0); // vanilla rolls into sweet
    expect(profile!.peaty).toBe(0);
  });

  it("requires the community threshold of tagged notes", () => {
    expect(
      profileFromNotes([{ flavorTags: { vanilla: 3 }, nose: null, palate: null, finish: null }]),
    ).toBeNull();
    expect(
      profileFromNotes([
        { flavorTags: null, nose: "oak", palate: null, finish: null },
        { flavorTags: {}, nose: null, palate: null, finish: null },
      ]),
    ).toBeNull();
  });
});

describe("enrichModel", () => {
  it("defaults to the active provider's Sonnet model and honors the env override", () => {
    expect(enrichModel()).toBe("claude-sonnet-5");
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    expect(enrichModel()).toBe("anthropic/claude-sonnet-4");
    delete process.env.OPENROUTER_API_KEY;
    process.env.WHAIKEY_ENRICH_MODEL = "claude-opus-4-8";
    try {
      expect(enrichModel()).toBe("claude-opus-4-8");
    } finally {
      delete process.env.WHAIKEY_ENRICH_MODEL;
    }
  });
});

describe("buildEnrichPrompt", () => {
  const bottle = {
    id: "test-bourbon",
    name: "Test Bourbon",
    category: "bourbon",
    distillery: "Test Distillery",
    region: "Kentucky",
    abv: 45,
    ageYears: 8,
    description: "A test bottling.",
    userNotes: ["nose: caramel; palate: oak"],
  };

  it("includes bottle context, notes, and the wedge taxonomy", () => {
    const prompt = buildEnrichPrompt([bottle], false);
    expect(prompt).toContain('"id":"test-bourbon"');
    expect(prompt).toContain("caramel");
    expect(prompt).toContain("A test bottling.");
    expect(prompt).toContain("peaty");
    expect(prompt).toContain("STRICT JSON");
    expect(prompt).not.toContain("search the web");
  });

  it("explicitly instructs discovering tasting notes via web search when enabled", () => {
    const prompt = buildEnrichPrompt([bottle], true);
    expect(prompt).toContain("search the web to discover published tasting notes");
    expect(prompt).toContain("tasting notes review");
  });
});

describe("enrichBottleProfiles", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("derives profiles from user notes without calling the model", async () => {
    const noted = await createTestBottle(db, { id: "noted-bottle", flavorProfile: null });
    const user = await createTestUser(db);
    await addNote(db, user.id, noted.id, { vanilla: 3, oak: 2 });
    await addNote(db, user.id, noted.id, { vanilla: 2, "black-pepper": 1 });

    const fake = makeFakeAnthropic([]); // any model call would throw
    const report = await enrichBottleProfiles(db, { client: fake.client });
    expect(report).toMatchObject({ candidates: 1, fromNotes: 1, fromAi: 0, batches: 0 });
    expect(fake.create).not.toHaveBeenCalled();

    const [updated] = await db.select().from(bottles).where(eq(bottles.id, noted.id));
    expect(updated.flavorProfile).not.toBeNull();
    expect(updated.flavorProfile!.sweet).toBeGreaterThan(0);
  });

  it("sends remaining bottles to the model with note snippets as context", async () => {
    const bare = await createTestBottle(db, { id: "bare-bottle", flavorProfile: null });
    const user = await createTestUser(db);
    // One note only — below the community threshold, but usable as context.
    await addNote(db, user.id, bare.id, { vanilla: 2 }, { nose: "campfire smoke", palate: "honey" });

    const fake = makeFakeAnthropic([textResponse([{ id: bare.id, profile: fullProfile() }])]);
    const report = await enrichBottleProfiles(db, { client: fake.client });
    expect(report).toMatchObject({ candidates: 1, fromNotes: 0, fromAi: 1, batches: 1 });

    const params = fake.create.mock.calls[0][0] as { model: string; messages: Array<{ content: string }> };
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.messages[0].content).toContain("campfire smoke");

    const [updated] = await db.select().from(bottles).where(eq(bottles.id, bare.id));
    expect(updated.flavorProfile).toEqual(fullProfile());
  });

  it("passes the web search tool by default and omits it with web: false", async () => {
    const bare = await createTestBottle(db, { id: "web-bottle", flavorProfile: null });
    const fake = makeFakeAnthropic([
      textResponse([{ id: bare.id, profile: fullProfile() }]),
      textResponse([{ id: bare.id, profile: fullProfile() }]),
    ]);
    await enrichBottleProfiles(db, { client: fake.client });
    const withWeb = fake.create.mock.calls[0][0] as { tools?: Array<{ type: string }> };
    expect(withWeb.tools?.[0].type).toBe("web_search_20260209");

    // Re-null the profile and run again without web.
    await db.update(bottles).set({ flavorProfile: null }).where(eq(bottles.id, bare.id));
    await enrichBottleProfiles(db, { client: fake.client, web: false });
    const withoutWeb = fake.create.mock.calls[1][0] as { tools?: Array<{ type: string }> };
    expect(withoutWeb.tools).toBeUndefined();
  });

  it("uses stored source facts and removes sourced bottles from the web-search budget", async () => {
    const bottle = await createTestBottle(db, { id: "sourced-bottle", flavorProfile: null, description: null });
    await db.insert(catalogSources).values({
      id: "official", name: "Official Producer", kind: "official", baseUrl: "https://producer.example",
      fetchPolicy: "structured", mediaPolicy: "display_remote",
    });
    await db.insert(bottleResources).values({
      id: "official-resource", bottleId: bottle.id, sourceId: "official", resourceType: "official_product",
      url: "https://producer.example/products/sourced", retrievedAt: new Date(),
    });
    await db.insert(bottleClaims).values({
      id: "official-description", bottleId: bottle.id, resourceId: "official-resource", field: "description",
      value: "Vanilla, toasted oak, and orange peel.", valueHash: "description-hash", status: "accepted",
    });
    const fake = makeFakeAnthropic([textResponse([{ id: bottle.id, profile: fullProfile() }])]);

    await enrichBottleProfiles(db, { client: fake.client, web: true });

    const params = fake.create.mock.calls[0][0] as {
      tools?: unknown;
      messages: Array<{ content: string }>;
    };
    expect(params.tools).toBeUndefined();
    expect(params.messages[0].content).toContain("Vanilla, toasted oak, and orange peel.");
    expect(params.messages[0].content).toContain("https://producer.example/products/sourced");
  });

  it("keeps catalog-only source facts in the flavor web-search budget", async () => {
    const bottle = await createTestBottle(db, { id: "catalog-only-source-facts", flavorProfile: null, description: null });
    await db.insert(catalogSources).values({
      id: "catalog-source", name: "Official Producer", kind: "official", baseUrl: "https://catalog.example",
      fetchPolicy: "structured", mediaPolicy: "display_remote",
    });
    await db.insert(bottleResources).values({
      id: "catalog-resource", bottleId: bottle.id, sourceId: "catalog-source", resourceType: "official_product",
      url: "https://catalog.example/product", retrievedAt: new Date(),
    });
    await db.insert(bottleClaims).values({
      id: "catalog-brand", bottleId: bottle.id, resourceId: "catalog-resource", field: "brand",
      value: "Catalog Brand", valueHash: "catalog-brand-hash", status: "accepted",
    });
    const fake = makeFakeAnthropic([textResponse([{ id: bottle.id, profile: fullProfile() }])]);

    await enrichBottleProfiles(db, { client: fake.client, web: true });

    const params = fake.create.mock.calls[0][0] as {
      tools?: Array<{ type: string }>;
      messages: Array<{ content: string }>;
    };
    expect(params.tools?.[0].type).toBe("web_search_20260209");
    expect(params.messages[0].content).toContain('"needsFlavorResearch":true');
    expect(params.messages[0].content).toContain("Catalog-only facts");
  });

  it("ignores disabled and review-required claims when deciding the web-search budget", async () => {
    const disabledBottle = await createTestBottle(db, { id: "disabled-source-bottle", flavorProfile: null });
    const reviewBottle = await createTestBottle(db, { id: "review-required-bottle", flavorProfile: null });
    await db.insert(catalogSources).values([
      { id: "disabled-source", name: "Disabled", kind: "official", baseUrl: "https://disabled.example", fetchPolicy: "structured", mediaPolicy: "link_only", enabled: false },
      { id: "review-source", name: "Registry", kind: "registry", baseUrl: "https://registry.example", fetchPolicy: "structured", mediaPolicy: "link_only" },
    ]);
    await db.insert(bottleResources).values([
      { id: "disabled-resource", bottleId: disabledBottle.id, sourceId: "disabled-source", resourceType: "official_product", url: "https://disabled.example/product", retrievedAt: new Date() },
      { id: "review-resource", bottleId: reviewBottle.id, sourceId: "review-source", resourceType: "registry", url: "https://registry.example/product", retrievedAt: new Date() },
    ]);
    await db.insert(bottleClaims).values([
      { id: "disabled-claim", bottleId: disabledBottle.id, resourceId: "disabled-resource", field: "description", value: "DISABLED_SECRET", valueHash: "disabled-hash", status: "accepted" },
      { id: "review-claim", bottleId: reviewBottle.id, resourceId: "review-resource", field: "description", value: "REVIEW_SECRET", valueHash: "review-hash", status: "review_required" },
    ]);
    const fake = makeFakeAnthropic([textResponse([
      { id: disabledBottle.id, profile: fullProfile() },
      { id: reviewBottle.id, profile: fullProfile() },
    ])]);

    await enrichBottleProfiles(db, { client: fake.client, web: true });

    const params = fake.create.mock.calls[0][0] as {
      tools?: Array<{ max_uses: number }>;
      messages: Array<{ content: string }>;
    };
    expect(params.tools?.[0].max_uses).toBe(2);
    expect(params.messages[0].content).not.toContain("DISABLED_SECRET");
    expect(params.messages[0].content).not.toContain("REVIEW_SECRET");
  });

  it("resumes pause_turn continuations and parses the joined output", async () => {
    const bare = await createTestBottle(db, { id: "paused-bottle", flavorProfile: null });
    const fake = makeFakeAnthropic([
      textResponse("Searching for tasting notes…", "pause_turn"),
      textResponse([{ id: bare.id, profile: fullProfile() }]),
    ]);
    const report = await enrichBottleProfiles(db, { client: fake.client, web: true });
    expect(report).toMatchObject({ fromAi: 1 });
    expect(fake.create).toHaveBeenCalledTimes(2);
  });

  it("batches by batchSize and reports per-bottle rejections", async () => {
    const a = await createTestBottle(db, { id: "aa-first", flavorProfile: null });
    const b = await createTestBottle(db, { id: "bb-second", flavorProfile: null });
    const c = await createTestBottle(db, { id: "cc-third", flavorProfile: null });

    const fake = makeFakeAnthropic([
      // Batch 1: one good entry, one invented id.
      textResponse([
        { id: a.id, profile: fullProfile() },
        { id: "not-a-real-bottle", profile: fullProfile() },
      ]),
      // Batch 2: malformed profile for c.
      textResponse([{ id: c.id, profile: { sweet: 5 } }]),
    ]);
    const report = await enrichBottleProfiles(db, { client: fake.client, batchSize: 2 });
    expect(report).toMatchObject({ candidates: 3, batches: 2, fromAi: 1, rejected: 2 });
    expect(fake.create).toHaveBeenCalledTimes(2);

    const remaining = await db.select({ id: bottles.id }).from(bottles).where(isNull(bottles.flavorProfile));
    expect(remaining.map((r) => r.id).sort()).toEqual([b.id, c.id]);
  });

  it("respects limit and dry run", async () => {
    await createTestBottle(db, { id: "aa-limit", flavorProfile: null });
    await createTestBottle(db, { id: "bb-limit", flavorProfile: null });

    // Usage on the fixture is load-bearing: `recordAiUsage` records nothing
    // when the response reported none, so without it the assertion below
    // passes whether or not the dry-run guard exists. It did, and only
    // re-running against the unguarded code showed it.
    const fake = makeFakeAnthropic([
      {
        ...textResponse([{ id: "aa-limit", profile: fullProfile() }]),
        usage: { input_tokens: 90, output_tokens: 30 },
      },
    ]);
    const report = await enrichBottleProfiles(db, { client: fake.client, limit: 1, dryRun: true });
    expect(report).toMatchObject({ candidates: 1, fromAi: 1, dryRun: true });

    const remaining = await db.select({ id: bottles.id }).from(bottles).where(isNull(bottles.flavorProfile));
    expect(remaining).toHaveLength(2);

    /**
     * "No database writes" has to include the meter reading.
     *
     * `writeProfile` already honoured `dryRun`; `recordAiUsage` did not, so a
     * dry run inserted `ai_usage` rows while advertising that it wrote
     * nothing. The model call is real and costs money either way, which is the
     * argument that made the write look correct — but a flag meaning "no
     * writes" has to mean it, or somebody reaches for a dry run precisely when
     * they must not write and gets a table they did not agree to.
     */
    expect(await db.select().from(aiUsage)).toHaveLength(0);
  });

  it("still records the meter reading on a real run", async () => {
    await createTestBottle(db, { id: "aa-metered", flavorProfile: null });
    // The shared helper above omits `usage`, and `recordAiUsage` deliberately
    // records nothing when the response reported none — so the fixture has to
    // carry it, or this test would assert something it could not produce.
    const fake = makeFakeAnthropic([
      {
        ...textResponse([{ id: "aa-metered", profile: fullProfile() }]),
        usage: { input_tokens: 120, output_tokens: 45 },
      },
    ]);
    await enrichBottleProfiles(db, { client: fake.client, limit: 1 });

    // The other half of the contract: suppressing telemetry in a dry run must
    // not suppress it everywhere, or the cost of enrichment goes unmeasured.
    const usage = await db.select().from(aiUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0].feature).toBe("enrich");
    expect(usage[0].userId).toBeNull();
    expect(usage[0].inputTokens).toBe(120);
  });

  it("survives non-JSON model output, counting the batch as rejected", async () => {
    await createTestBottle(db, { id: "aa-garbage", flavorProfile: null });
    const fake = makeFakeAnthropic([textResponse("I cannot help with that.")]);
    const report = await enrichBottleProfiles(db, { client: fake.client });
    expect(report).toMatchObject({ fromAi: 0, rejected: 1 });
  });
});
