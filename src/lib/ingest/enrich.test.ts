import { beforeEach, describe, expect, it } from "vitest";
import { eq, isNull } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles } from "@/db/schema";
import { makeFakeAnthropic } from "@/lib/ai/testing";
import { createTestBottle, setupTestDb } from "@/test/helpers";
import { buildEnrichPrompt, cleanProfile, enrichBottleProfiles } from "./enrich";

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

const textResponse = (payload: unknown) => ({
  id: "msg_test",
  content: [{ type: "text", text: JSON.stringify(payload) }],
  stop_reason: "end_turn",
});

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

describe("buildEnrichPrompt", () => {
  it("includes every bottle and the wedge taxonomy", () => {
    const prompt = buildEnrichPrompt([
      {
        id: "test-bourbon",
        name: "Test Bourbon",
        category: "bourbon",
        distillery: "Test Distillery",
        region: "Kentucky",
        abv: 45,
        ageYears: 8,
      },
    ]);
    expect(prompt).toContain('"id":"test-bourbon"');
    expect(prompt).toContain("peaty");
    expect(prompt).toContain("STRICT JSON");
  });
});

describe("enrichBottleProfiles", () => {
  let db: DB;

  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("fills profiles for bottles lacking one and leaves others alone", async () => {
    const bare = await createTestBottle(db, { id: "bare-bottle", flavorProfile: null });
    const curated = await createTestBottle(db, {
      id: "curated-bottle",
      flavorProfile: { sweet: 9, woody: 1, fruity: 0, floral: 0, grain: 0, spicy: 0, peaty: 0, feinty: 0 },
    });

    const fake = makeFakeAnthropic([
      textResponse([{ id: bare.id, profile: fullProfile() }]),
    ]);
    const report = await enrichBottleProfiles(db, { client: fake.client });
    expect(report).toMatchObject({ candidates: 1, batches: 1, enriched: 1, rejected: 0 });

    const [updated] = await db.select().from(bottles).where(eq(bottles.id, bare.id));
    expect(updated.flavorProfile).toEqual(fullProfile());
    const [untouched] = await db.select().from(bottles).where(eq(bottles.id, curated.id));
    expect(untouched.flavorProfile!.sweet).toBe(9);
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
    expect(report).toMatchObject({ candidates: 3, batches: 2, enriched: 1, rejected: 2 });
    expect(fake.create).toHaveBeenCalledTimes(2);

    const remaining = await db.select({ id: bottles.id }).from(bottles).where(isNull(bottles.flavorProfile));
    expect(remaining.map((r) => r.id).sort()).toEqual([b.id, c.id]);
  });

  it("respects limit and dry run", async () => {
    await createTestBottle(db, { id: "aa-limit", flavorProfile: null });
    await createTestBottle(db, { id: "bb-limit", flavorProfile: null });

    const fake = makeFakeAnthropic([textResponse([{ id: "aa-limit", profile: fullProfile() }])]);
    const report = await enrichBottleProfiles(db, { client: fake.client, limit: 1, dryRun: true });
    expect(report).toMatchObject({ candidates: 1, enriched: 1, dryRun: true });

    const remaining = await db.select({ id: bottles.id }).from(bottles).where(isNull(bottles.flavorProfile));
    expect(remaining).toHaveLength(2);
  });

  it("survives non-JSON model output, counting the batch as rejected", async () => {
    await createTestBottle(db, { id: "aa-garbage", flavorProfile: null });
    const fake = makeFakeAnthropic([
      { id: "msg", content: [{ type: "text", text: "I cannot help with that." }], stop_reason: "end_turn" },
    ]);
    const report = await enrichBottleProfiles(db, { client: fake.client });
    expect(report).toMatchObject({ enriched: 0, rejected: 1 });
  });
});
