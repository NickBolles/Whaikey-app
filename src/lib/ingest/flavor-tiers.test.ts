import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottleFlavorProvenance, bottlePopularityDaily, bottles, criticNotes, pours, tastingNotes, userBottles, userProfiles } from "@/db/schema";
import { utcDay } from "@/lib/popularity";
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

async function addNote(
  db: DB,
  bottleId: string,
  flavorTags: Record<string, number> | null,
  nose?: string,
  opts: { visibility?: "private" | "public"; socialEnabled?: boolean } = {},
) {
  const user = await createTestUser(db);
  await db.insert(userProfiles).values({
    userId: user.id, handle: `h${user.id.slice(-8)}`, displayName: "Taster", isPublic: true, socialEnabled: opts.socialEnabled ?? true,
  });
  const pourId = uid("pour");
  await db.insert(pours).values({ id: pourId, userId: user.id, bottleId, rating: 4, visibility: opts.visibility ?? "public" });
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

  it("replaces a legacy profile only for an allowed, web-grounded write, keeping the old one", async () => {
    const legacy = await createTestBottle(db, { flavorProfile: profile({ peaty: 9 }) });
    // Not allowed, or allowed but below model_web: untouched.
    expect(await writeTieredProfiles(db, [write(legacy.id, { tier: "model_web", pass: "heavy" })])).toEqual([]);
    expect(await writeTieredProfiles(db, [write(legacy.id, { allowLegacy: true })])).toEqual([]);
    expect((await prof(db, legacy.id))!.peaty).toBe(9);
    const ok = await writeTieredProfiles(db, [write(legacy.id, { tier: "model_web", pass: "heavy", allowLegacy: true, profile: profile({ peaty: 2 }) })]);
    expect(ok).toEqual([legacy.id]);
    expect((await prof(db, legacy.id))!.peaty).toBe(2);
    expect(await prov(db, legacy.id)).toMatchObject({ tier: "model_web", replacedLegacyProfile: profile({ peaty: 9 }) });
    // A later write keeps the record of what the legacy profile was.
    await writeTieredProfiles(db, [write(legacy.id, { tier: "model_web", pass: "heavy", profile: profile({ peaty: 3 }) })]);
    expect(await prov(db, legacy.id)).toMatchObject({ replacedLegacyProfile: profile({ peaty: 9 }) });
  });

  it("never replaces a legacy profile on a bottle with tasting notes or a user submission", async () => {
    const noted = await createTestBottle(db, { flavorProfile: profile({ peaty: 9 }) });
    await addNote(db, noted.id, null, "smoke and brine");
    const user = await createTestUser(db);
    const submitted = await createTestBottle(db, { flavorProfile: profile({ peaty: 9 }), status: "user_submitted", submittedBy: user.id });
    const allowed = { tier: "model_web" as const, pass: "heavy" as const, allowLegacy: true, profile: profile({ peaty: 1 }) };
    expect(await writeTieredProfiles(db, [write(noted.id, allowed), write(submitted.id, allowed)])).toEqual([]);
    expect((await prof(db, noted.id))!.peaty).toBe(9);
    expect((await prof(db, submitted.id))!.peaty).toBe(9);
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
    await addNote(db, community.id, { vanilla: 3, caramel: 1 });
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
    await addNote(db, b.id, { vanilla: 2, honey: 3 });
    await runFreePass(db);
    expect((await prov(db, b.id))!.tier).toBe("community");
    expect((await prof(db, b.id))!.sweet).toBeGreaterThan(1);
  });

  it("never builds a shared profile from private, stepped-back or too-few people's notes", async () => {
    const text = "Notes of honey, vanilla, toasted oak and cinnamon with dried cherry.";
    const priv = await createTestBottle(db, { flavorProfile: null });
    for (let i = 0; i < 3; i++) await addNote(db, priv.id, { vanilla: 3, caramel: 2 }, text, { visibility: "private" });
    const stepped = await createTestBottle(db, { flavorProfile: null });
    for (let i = 0; i < 3; i++) await addNote(db, stepped.id, { vanilla: 3, caramel: 2 }, text, { socialEnabled: false });
    const two = await createTestBottle(db, { flavorProfile: null });
    for (let i = 0; i < 2; i++) await addNote(db, two.id, { vanilla: 3, caramel: 2 }, text);
    const report = await runFreePass(db);
    expect(report).toMatchObject({ community: 0, keyword: 0, written: 0 });
    for (const b of [priv, stepped, two]) expect(await prof(db, b.id)).toBeNull();
  });

  it("counts the people behind the tagged notes, and withdraws a community profile that falls below the floor", async () => {
    const b = await createTestBottle(db, { flavorProfile: null });
    // One person's two tagged notes + two people with text only: not a community of three.
    const solo = await createTestUser(db);
    await db.insert(userProfiles).values({ userId: solo.id, handle: `h${solo.id.slice(-8)}`, displayName: "Solo", isPublic: true, socialEnabled: true });
    for (let i = 0; i < 2; i++) {
      const pourId = uid("pour");
      await db.insert(pours).values({ id: pourId, userId: solo.id, bottleId: b.id, rating: 4, visibility: "public" });
      await db.insert(tastingNotes).values({ id: uid("note"), pourId, flavorTags: { vanilla: 3, caramel: 2 } });
    }
    await addNote(db, b.id, null, "nice");
    await addNote(db, b.id, null, "fine");
    expect((await runFreePass(db)).community).toBe(0);

    const c = await createTestBottle(db, { flavorProfile: null });
    for (let i = 0; i < 3; i++) await addNote(db, c.id, { vanilla: 3, caramel: 2 });
    await runFreePass(db);
    expect((await prov(db, c.id))!.tier).toBe("community");
    // One contributor steps back: the profile is withdrawn on the next pass.
    const [pour] = await db.select().from(pours).where(eq(pours.bottleId, c.id)).limit(1);
    await db.update(userProfiles).set({ socialEnabled: false }).where(eq(userProfiles.userId, pour.userId));
    expect((await runFreePass(db)).communityWithdrawn).toBe(1);
    expect(await prof(db, c.id)).toBeNull();
    expect(await prov(db, c.id)).toBeUndefined();
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
      { pass: "heavy", model: "gpt-6.1-sol", bottleIds: [popular.id], raw: JSON.stringify([{ id: popular.id, profile: profile({ woody: 8 }), sources: ["https://reviews.example.com/r"] }]), completedAt: "" },
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

  it("sends legacy profiles in the popularity top set to heavy and lets apply replace them", async () => {
    const searched = await createTestBottle(db, { flavorProfile: profile({ peaty: 9 }), name: "Searched Legacy" });
    const quietLegacy = await createTestBottle(db, { flavorProfile: profile({ peaty: 9 }), name: "Quiet Legacy" });
    const notedLegacy = await createTestBottle(db, { flavorProfile: profile({ peaty: 9 }), name: "Noted Legacy" });
    await addNote(db, notedLegacy.id, null, "smoke");
    await db.insert(bottlePopularityDaily).values({ bottleId: searched.id, day: utcDay(), searches: 30 });

    const exported = await exportModelCandidates(db, { cheapLimit: 10, heavyTop: 1 });
    // The noted bottle's pour makes it popular too, but its notes protect it; the quiet one is outside the top set.
    expect(exported.batches.filter((b) => b.pass === "heavy").flatMap((b) => b.bottleIds)).toEqual([searched.id]);
    expect(exported.batches.filter((b) => b.pass === "cheap")).toEqual([]);
    expect(exported.counts).toMatchObject({ heavy: 1, heavyLegacy: 1 });

    const raw = (ids: string[]) => JSON.stringify(ids.map((id) => ({ id, profile: profile({ peaty: 1 }), sources: ["https://reviews.example.com/r"] })));
    // A results file that claims more than the export offered still only replaces the top set.
    const ids = [searched.id, quietLegacy.id, notedLegacy.id];
    const report = await applyModelResults(db, [{ pass: "heavy", model: "gpt-6.1-sol", bottleIds: ids, raw: raw(ids), completedAt: "" }], { legacyTop: 1 });
    expect(report).toMatchObject({ parsed: 3, written: 1, legacyReplaced: 1 });
    expect((await prof(db, searched.id))!.peaty).toBe(1);
    expect((await prof(db, quietLegacy.id))!.peaty).toBe(9);
    expect((await prof(db, notedLegacy.id))!.peaty).toBe(9);
    expect(await prov(db, searched.id)).toMatchObject({ tier: "model_web", replacedLegacyProfile: profile({ peaty: 9 }) });
  });

  it("keeps the higher tier when a bottle is in both a cheap and a heavy batch", () => {
    const raw = (n: number) => JSON.stringify([{ id: "a", profile: profile({ sweet: n }), sources: ["https://reviews.example.com/r"] }]);
    const { writes } = parseModelResults([
      { pass: "heavy", model: "gpt-6.1-sol", bottleIds: ["a"], raw: raw(9), completedAt: "" },
      { pass: "cheap", model: "gpt-6-luna", bottleIds: ["a"], raw: raw(2), completedAt: "" },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ tier: "model_web", profile: { sweet: 9 } });
  });

  it("accepts provider-qualified model ids but not arbitrary strings", () => {
    const raw = JSON.stringify([{ id: "a", profile: profile() }]);
    expect(parseModelResults([{ pass: "cheap", model: "anthropic/claude-haiku-4.5", bottleIds: ["a"], raw, completedAt: "" }]).writes).toHaveLength(1);
    expect(parseModelResults([{ pass: "cheap", model: "a/b/c d", bottleIds: ["a"], raw, completedAt: "" }]).writes).toHaveLength(0);
  });

  it("a heavy answer without a cited https source is recall, stored at the quick tier", async () => {
    const legacy = await createTestBottle(db, { flavorProfile: profile({ peaty: 9 }) });
    await db.insert(bottlePopularityDaily).values({ bottleId: legacy.id, day: utcDay(), searches: 30 });
    const fresh = await createTestBottle(db, { flavorProfile: null });
    const ids = [legacy.id, fresh.id];
    const raw = JSON.stringify(ids.map((id) => ({ id, profile: profile({ peaty: 1 }), sources: ["http://insecure.example/x", "not a url"] })));
    const report = await applyModelResults(db, [{ pass: "heavy", model: "gpt-6.1-sol", bottleIds: ids, raw, completedAt: "" }]);
    expect(report).toMatchObject({ written: 1, legacyReplaced: 0 });
    expect((await prof(db, legacy.id))!.peaty).toBe(9);
    expect(await prov(db, fresh.id)).toMatchObject({ tier: "model", pass: "heavy" });
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

  it("rejects out-of-range, fractional, string and extra-key scores instead of normalizing them", () => {
    const bad = [profile({ sweet: 100 }), profile({ sweet: 2.5 }), { ...profile(), sweet: "6" }, { ...profile(), smoky: 2 }];
    const { writes, rejected } = parseModelResults(
      bad.map((p, i) => ({ pass: "cheap" as const, model: "gpt-6-luna", bottleIds: [`b${i}`], raw: JSON.stringify([{ id: `b${i}`, profile: p }]), completedAt: "" })),
    );
    expect(writes).toEqual([]);
    expect(rejected).toBe(4);
  });
});
