import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottleFlavorProvenance, bottles, criticNotes, pours, tastingNotes, userBottles } from "@/db/schema";
import { WEDGE_IDS } from "@/lib/flavor-wheel";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import {
  applyModelResults,
  exportModelCandidates,
  flavorCoverage,
  isValidWedgeProfile,
  keywordProfile,
  parseModelResults,
  runFreePass,
  writeTieredProfiles,
  type ProfileWrite,
} from "./flavor-tiers";

const profile = (over: Record<string, number> = {}) => ({
  fruity: 3, floral: 1, grain: 4, sweet: 6, woody: 5, spicy: 3, peaty: 0, feinty: 1, ...over,
});

const write = (bottleId: string, over: Partial<ProfileWrite> = {}): ProfileWrite => ({
  bottleId, profile: profile(), tier: "model", confidence: 0.5, method: "codex:gpt-test", model: "gpt-test",
  pass: "cheap", inputHash: null, ...over,
});

async function addNote(db: DB, bottleId: string, flavorTags: Record<string, number> | null, nose?: string) {
  const user = await createTestUser(db);
  const pourId = uid("pour");
  await db.insert(pours).values({ id: pourId, userId: user.id, bottleId, rating: 4 });
  await db.insert(tastingNotes).values({ id: uid("note"), pourId, flavorTags, nose: nose ?? null });
}

const prov = async (db: DB, id: string) =>
  (await db.select().from(bottleFlavorProvenance).where(eq(bottleFlavorProvenance.bottleId, id)))[0];
const prof = async (db: DB, id: string) =>
  (await db.select({ p: bottles.flavorProfile }).from(bottles).where(eq(bottles.id, id)))[0]?.p;

describe("isValidWedgeProfile", () => {
  it("requires exactly the 8 wedge ids with integer 0-10 scores", () => {
    expect(isValidWedgeProfile(profile())).toBe(true);
    expect(isValidWedgeProfile({ ...profile(), smoky: 2 })).toBe(false);
    expect(isValidWedgeProfile({ ...profile(), sweet: 11 })).toBe(false);
    expect(isValidWedgeProfile({ ...profile(), sweet: 2.5 })).toBe(false);
    expect(isValidWedgeProfile(Object.fromEntries(WEDGE_IDS.map((w) => [w, 0])))).toBe(false);
  });
});

describe("keywordProfile", () => {
  it("maps described flavors onto wedges", () => {
    const p = keywordProfile({
      description: "Rich vanilla and caramel with toasted oak, a hint of cinnamon and smoke.",
      producerFlavorTags: null, criticNotes: [], userNotes: [],
    });
    expect(p).not.toBeNull();
    expect(isValidWedgeProfile(p)).toBe(true);
    expect(p!.sweet).toBeGreaterThan(0);
    expect(p!.woody).toBeGreaterThan(0);
  });

  it("returns null below the evidence floor", () => {
    expect(keywordProfile({ description: "A smooth vanilla whiskey.", producerFlavorTags: null, criticNotes: [], userNotes: [] })).toBeNull();
    expect(keywordProfile({ description: null, producerFlavorTags: null, criticNotes: [], userNotes: [] })).toBeNull();
  });
});

describe("writeTieredProfiles", () => {
  let db: DB;
  beforeEach(async () => { db = await setupTestDb(); });

  it("fills empty profiles and records provenance", async () => {
    const b = await createTestBottle(db, { flavorProfile: null });
    expect(await writeTieredProfiles(db, [write(b.id)])).toEqual([b.id]);
    expect(await prof(db, b.id)).toEqual(profile());
    expect(await prov(db, b.id)).toMatchObject({ tier: "model", method: "codex:gpt-test", pass: "cheap" });
  });

  it("never overwrites legacy (untracked) or higher-tier profiles", async () => {
    const legacy = await createTestBottle(db, { flavorProfile: profile({ peaty: 9 }) });
    const web = await createTestBottle(db, { flavorProfile: null });
    await writeTieredProfiles(db, [write(web.id, { tier: "model_web", pass: "heavy", profile: profile({ sweet: 9 }) })]);
    const written = await writeTieredProfiles(db, [write(legacy.id), write(web.id, { profile: profile({ sweet: 1 }) })]);
    expect(written).toEqual([]);
    expect((await prof(db, legacy.id))!.peaty).toBe(9);
    expect((await prof(db, web.id))!.sweet).toBe(9);
    expect(await prov(db, legacy.id)).toBeUndefined();
  });

  it("upgrades lower tiers", async () => {
    const b = await createTestBottle(db, { flavorProfile: null });
    await writeTieredProfiles(db, [write(b.id, { tier: "keyword", pass: "free", method: "keyword-matcher", model: null })]);
    await writeTieredProfiles(db, [write(b.id, { profile: profile({ fruity: 8 }) })]);
    expect((await prof(db, b.id))!.fruity).toBe(8);
    expect((await prov(db, b.id))!.tier).toBe("model");
  });

  it("rejects invalid profiles before touching the database", async () => {
    const b = await createTestBottle(db, { flavorProfile: null });
    await expect(writeTieredProfiles(db, [write(b.id, { profile: { sweet: 3 } })])).rejects.toThrow();
    expect(await prof(db, b.id)).toBeNull();
  });
});

describe("runFreePass", () => {
  let db: DB;
  beforeEach(async () => { db = await setupTestDb(); });

  it("rolls up community notes, keyword-matches text, and is idempotent", async () => {
    const community = await createTestBottle(db, { flavorProfile: null });
    await addNote(db, community.id, { vanilla: 3, caramel: 2 });
    await addNote(db, community.id, { vanilla: 2, "black-pepper": 1 });
    const described = await createTestBottle(db, {
      flavorProfile: null,
      description: "Notes of honey, vanilla and toasted oak with a cinnamon finish.",
    });
    const critic = await createTestBottle(db, { flavorProfile: null });
    await db.insert(criticNotes).values({
      id: uid("cn"), bottleId: critic.id, publication: "Test", note: "Big peat and campfire, medicinal brine, bright citrus.",
      sourceUrl: "https://example.com/r",
    });
    const bare = await createTestBottle(db, { flavorProfile: null });
    const legacy = await createTestBottle(db, { flavorProfile: profile(), description: "vanilla caramel oak cinnamon" });

    const first = await runFreePass(db);
    expect(first).toMatchObject({ community: 1, keyword: 2, written: 3 });
    expect((await prov(db, community.id))!.tier).toBe("community");
    expect((await prov(db, described.id))!).toMatchObject({ tier: "keyword", pass: "free", method: "keyword-matcher" });
    expect((await prof(db, critic.id))!.peaty).toBeGreaterThan(0);
    expect(await prof(db, bare.id)).toBeNull();
    expect(await prov(db, legacy.id)).toBeUndefined();

    const second = await runFreePass(db);
    expect(second).toMatchObject({ community: 0, keyword: 0, written: 0, keywordUnchanged: 2 });
  });

  it("lets user notes override a model estimate", async () => {
    const b = await createTestBottle(db, { flavorProfile: null });
    await writeTieredProfiles(db, [write(b.id, { profile: profile({ sweet: 1 }) })]);
    await addNote(db, b.id, { vanilla: 3, caramel: 3, honey: 3 });
    await addNote(db, b.id, { vanilla: 3, caramel: 3 });
    await runFreePass(db);
    expect((await prov(db, b.id))!.tier).toBe("community");
    expect((await prof(db, b.id))!.sweet).toBeGreaterThan(1);
  });

  it("dry run writes nothing", async () => {
    const b = await createTestBottle(db, { flavorProfile: null, description: "honey, vanilla, toasted oak, cinnamon" });
    const report = await runFreePass(db, { dryRun: true });
    expect(report.keyword).toBe(1);
    expect(await prof(db, b.id)).toBeNull();
  });
});

describe("model export/apply", () => {
  let db: DB;
  beforeEach(async () => { db = await setupTestDb(); });

  it("exports popular bottles to heavy and the rest to cheap, then applies validated results", async () => {
    const popular = await createTestBottle(db, { flavorProfile: null, name: "Popular 12" });
    const quiet = await createTestBottle(db, { flavorProfile: null, name: "Quiet 8" });
    const user = await createTestUser(db);
    await db.insert(userBottles).values({ id: uid("ub"), userId: user.id, bottleId: popular.id, relationship: "own" });

    const exported = await exportModelCandidates(db, { cheapLimit: 10, heavyTop: 10 });
    const heavy = exported.batches.filter((b) => b.pass === "heavy");
    const cheap = exported.batches.filter((b) => b.pass === "cheap");
    expect(heavy.flatMap((b) => b.bottleIds)).toEqual([popular.id]);
    expect(cheap.flatMap((b) => b.bottleIds)).toEqual([popular.id, quiet.id]);
    expect(cheap[0].prompt).toContain(quiet.id);

    const report = await applyModelResults(db, [
      { pass: "heavy", model: "gpt-6.1-sol", bottleIds: [popular.id], raw: JSON.stringify([{ id: popular.id, profile: profile({ woody: 8 }) }]), completedAt: "" },
      {
        pass: "cheap", model: "gpt-6-luna", bottleIds: [quiet.id],
        raw: "```json\n" + JSON.stringify([{ id: quiet.id, profile: profile() }, { id: "invented", profile: profile() }]) + "\n```",
        completedAt: "",
      },
    ]);
    expect(report).toMatchObject({ parsed: 2, written: 2 });
    expect((await prov(db, popular.id))!).toMatchObject({ tier: "model_web", model: "gpt-6.1-sol", pass: "heavy" });
    expect((await prov(db, quiet.id))!).toMatchObject({ tier: "model", method: "codex:gpt-6-luna" });
    expect(await flavorCoverage(db)).toMatchObject({ bottles: 2, withProfile: 2, coveragePct: 100, byTier: { model: 1, model_web: 1 } });
  });

  it("keeps the higher tier when a bottle is in both a cheap and a heavy batch", () => {
    const raw = (n: number) => JSON.stringify([{ id: "a", profile: profile({ sweet: n }) }]);
    const { writes } = parseModelResults([
      { pass: "heavy", model: "gpt-6.1-sol", bottleIds: ["a"], raw: raw(9), completedAt: "" },
      { pass: "cheap", model: "gpt-6-luna", bottleIds: ["a"], raw: raw(2), completedAt: "" },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ tier: "model_web", profile: { sweet: 9 } });
  });

  it("drops ids outside the batch, bad shapes, and unknown passes", () => {
    const { writes, rejected } = parseModelResults([
      { pass: "cheap", model: "gpt-6-luna", bottleIds: ["a", "b"], raw: JSON.stringify([{ id: "a", profile: { sweet: 3 } }, { id: "z", profile: profile() }]), completedAt: "" },
      { pass: "free" as never, model: "x1", bottleIds: ["c"], raw: JSON.stringify([{ id: "c", profile: profile() }]), completedAt: "" },
      { pass: "cheap", model: "gpt-6-luna", bottleIds: ["d"], raw: "not json at all", completedAt: "" },
    ]);
    expect(writes).toEqual([]);
    expect(rejected).toBe(4);
  });
});
