import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { agreementRows, getBottleComparison, matchPercent, meanTags } from "./bottle-compare";

describe("matchPercent", () => {
  it("is matched intensity over total intensity across the union", () => {
    // union: campfire max 3 min 2, brine max 2 min 0, vanilla max 1 min 0
    expect(matchPercent({ campfire: 2, vanilla: 1 }, { campfire: 3, brine: 2 })).toBe(33);
  });

  it("is 100 for identical notes and 0 for disjoint ones", () => {
    expect(matchPercent({ oak: 2 }, { oak: 2 })).toBe(100);
    expect(matchPercent({ oak: 2 }, { honey: 2 })).toBe(0);
  });

  it("is null when there is nothing to compare", () => {
    expect(matchPercent({}, {})).toBeNull();
    expect(matchPercent(null, undefined)).toBeNull();
  });

  it("ignores ids outside the wheel", () => {
    expect(matchPercent({ "not-a-leaf": 3 }, { "also-fake": 2 })).toBeNull();
  });
});

describe("agreementRows", () => {
  it("keeps flavors only the reference logged, with a zero bar for you", () => {
    const rows = agreementRows({ campfire: 3 }, { campfire: 2, medicinal: 3 });
    expect(rows).toEqual([
      { leafId: "campfire", mine: 3, theirs: 2 },
      { leafId: "medicinal", mine: 0, theirs: 3 },
    ]);
  });

  it("sorts by combined intensity and caps at 6", () => {
    const mine = { vanilla: 1, oak: 2, cherry: 1, honey: 1, campfire: 3, brine: 1, peat: 1 };
    const rows = agreementRows(mine, { campfire: 3 });
    expect(rows).toHaveLength(6);
    expect(rows[0].leafId).toBe("campfire");
  });
});

describe("meanTags", () => {
  it("averages per leaf over the contributors who named it", () => {
    expect(meanTags([{ campfire: 3 }, { campfire: 1, brine: 2 }])).toEqual({
      campfire: 2,
      brine: 2,
    });
  });

  it("drops invalid ids and empty records", () => {
    expect(meanTags([{ fake: 3 }, null, {}])).toEqual({});
  });
});

describe("getBottleComparison", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  async function follow(a: string, b: string) {
    await db.insert(schema.follows).values([
      { id: uid("f"), followerId: a, followeeId: b, state: "accepted" },
      { id: uid("f"), followerId: b, followeeId: a, state: "accepted" },
    ]);
  }

  async function profile(userId: string, handle: string) {
    await db.insert(schema.userProfiles).values({
      userId,
      handle,
      displayName: handle,
      isPublic: true,
      socialEnabled: true,
    });
  }

  async function pourWithNote(
    userId: string,
    bottleId: string,
    flavorTags: Record<string, number>,
    opts: { visibility?: schema.PourVisibility; rating?: number; palate?: string } = {},
  ) {
    const [pour] = await db
      .insert(schema.pours)
      .values({
        id: uid("pour"),
        userId,
        bottleId,
        visibility: opts.visibility ?? "private",
        rating: opts.rating,
      })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: pour.id,
      flavorTags,
      palate: opts.palate,
    });
    return pour;
  }

  it("keeps the three reference sets distinct", async () => {
    const viewer = await createTestUser(db);
    const friend = await createTestUser(db);
    const stranger = await createTestUser(db);
    const bottle = await createTestBottle(db, {
      name: "Islay 16",
      description: "Deep smoke over dried fruit.",
      producerFlavorTags: { peat: 3, campfire: 2 },
      producerFlavorSourceUrl: "https://example.com/notes",
      producerFlavorSourceLabel: "Distillery tasting notes",
    });
    await profile(viewer.id, "viewer");
    await profile(friend.id, "friend");
    await profile(stranger.id, "stranger");
    await follow(viewer.id, friend.id);

    await pourWithNote(viewer.id, bottle.id, { campfire: 3, brine: 1 });
    await pourWithNote(friend.id, bottle.id, { campfire: 2, peat: 2 }, { visibility: "friends", rating: 4.5, palate: "Smoke first." });
    await pourWithNote(stranger.id, bottle.id, { medicinal: 3 }, { visibility: "public", rating: 4 });
    await db.insert(schema.criticNotes).values({
      id: uid("critic"),
      bottleId: bottle.id,
      publication: "Whisky Review",
      score: "91",
      scoreScale: "/100",
      note: "Tar and iodine, long finish.",
      flavorTags: { tar: 2 },
      sourceUrl: "https://example.com/review",
    });

    const cmp = await getBottleComparison(db, viewer.id, bottle.id);
    expect(cmp).not.toBeNull();
    expect(cmp!.viewerTags).toEqual({ campfire: 3, brine: 1 });

    // Friends: only the mutual follow, not the stranger.
    expect(cmp!.friends.count).toBe(1);
    expect(cmp!.friends.tags).toEqual({ campfire: 2, peat: 2 });
    expect(cmp!.friends.notes[0].text).toBe("Smoke first.");

    // Community: only the public pour, not the friend's friends-only one —
    // and as an ANONYMOUS aggregate: no author, no prose, nothing that could
    // surface a stranger's note before S4 public discovery.
    expect(cmp!.community.count).toBe(1);
    expect(cmp!.community.tags).toEqual({ medicinal: 3 });
    expect(cmp!.community).not.toHaveProperty("notes");
    expect(JSON.stringify(cmp!.community)).not.toContain("stranger");

    // Professional: producer plus critic, merged by max, both preserved.
    expect(cmp!.professional.tags).toEqual({ peat: 3, campfire: 2, tar: 2 });
    expect(cmp!.professional.critics[0].publication).toBe("Whisky Review");
    expect(cmp!.professional.critics[0].sourceUrl).toBe("https://example.com/review");
    // The catalog description is Whaikey's editorial copy, not the producer's
    // prose, so it never rides along under the producer's attribution.
    expect(cmp!.professional.producer).toEqual({
      sourceLabel: "Distillery tasting notes",
      sourceUrl: "https://example.com/notes",
      tags: { peat: 3, campfire: 2 },
    });

    // Three different match percentages — the point of the screen.
    const friendsMatch = matchPercent(cmp!.viewerTags, cmp!.friends.tags);
    const communityMatch = matchPercent(cmp!.viewerTags, cmp!.community.tags);
    const proMatch = matchPercent(cmp!.viewerTags, cmp!.professional.tags);
    expect(new Set([friendsMatch, communityMatch, proMatch]).size).toBe(3);
  });

  it("never counts the viewer's own public pour as community", async () => {
    const viewer = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "B" });
    await profile(viewer.id, "viewer");
    await pourWithNote(viewer.id, bottle.id, { oak: 2 }, { visibility: "public" });

    const cmp = await getBottleComparison(db, viewer.id, bottle.id);
    expect(cmp!.community.count).toBe(0);
  });

  it("excludes blocked users from the community in both directions", async () => {
    const viewer = await createTestUser(db);
    const blocked = await createTestUser(db);
    const bottle = await createTestBottle(db, { name: "B" });
    await profile(viewer.id, "viewer");
    await profile(blocked.id, "blockedone");
    await pourWithNote(blocked.id, bottle.id, { oak: 2 }, { visibility: "public" });
    await db.insert(schema.blocks).values({ id: uid("blk"), blockerId: blocked.id, blockedId: viewer.id });

    const cmp = await getBottleComparison(db, viewer.id, bottle.id);
    expect(cmp!.community.count).toBe(0);
  });

  it("returns null for an unknown bottle and empty sets for a fresh one", async () => {
    const viewer = await createTestUser(db);
    expect(await getBottleComparison(db, viewer.id, "nope")).toBeNull();

    const bottle = await createTestBottle(db, { name: "Fresh" });
    const cmp = await getBottleComparison(db, viewer.id, bottle.id);
    expect(cmp!.viewerPourId).toBeNull();
    expect(cmp!.friends.count).toBe(0);
    expect(cmp!.community.count).toBe(0);
    expect(cmp!.professional.producer).toBeNull();
    expect(cmp!.professional.critics).toEqual([]);
  });
});
