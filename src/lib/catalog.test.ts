import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { setupTestDb, createTestBottle, createTestUser, uid } from "@/test/helpers";
import {
  SUBMISSION_LIMIT_PER_HOUR,
  SubmissionRateLimitedError,
  findSubmissionDuplicates,
  listOwnSubmissions,
  looksLikeDuplicate,
  publishSubmissionUpc,
  submitBottle,
} from "./catalog";
import { canViewBottle } from "./catalog-visibility";
import { searchBottles, getBottleDetail } from "./search";

/**
 * Review PLAN-A1: a scan/search/import miss was terminal because there was no
 * way to add a bottle. These tests hold the two halves of the fix apart — the
 * bottle is usable immediately, and it is nobody else's until it is reviewed.
 */
let db: DB;
let alice: schema.User;
let bob: schema.User;

beforeEach(async () => {
  db = await setupTestDb();
  alice = await createTestUser(db, { name: "Alice" });
  bob = await createTestUser(db, { name: "Bob" });
});

describe("submitBottle", () => {
  it("writes a usable bottle and a pending review row", async () => {
    const { bottle, submissionId } = await submitBottle(db, alice.id, {
      name: "Barrell Dovetail",
      category: "american-other",
    });

    expect(bottle.status).toBe("user_submitted");
    expect(bottle.submittedBy).toBe(alice.id);

    const [submission] = await db
      .select()
      .from(schema.bottleSubmissions)
      .where(eq(schema.bottleSubmissions.id, submissionId));
    expect(submission).toMatchObject({ state: "pending", bottleId: bottle.id, source: "direct" });
  });

  it("links a distillery it already knows and parks one it doesn't", async () => {
    await db
      .insert(schema.distilleries)
      .values({ id: uid("dist"), name: "Heaven Hill", country: "USA" });

    const known = await submitBottle(db, alice.id, {
      name: "Elijah Craig Toasted",
      category: "bourbon",
      // Case shouldn't matter — people type what's on the label.
      distillery: "heaven hill",
    });
    expect(known.bottle.distilleryId).not.toBeNull();

    const unknown = await submitBottle(db, alice.id, {
      name: "Some Small Barn Rye",
      category: "rye",
      distillery: "Barn Number Nine",
    });
    // User input must never mint a distillery row: that is a second catalog
    // with no review path. The typed name waits on the submission instead.
    expect(unknown.bottle.distilleryId).toBeNull();
    const [row] = await db
      .select()
      .from(schema.bottleSubmissions)
      .where(eq(schema.bottleSubmissions.bottleId, unknown.bottle.id));
    expect(row.distilleryText).toBe("Barn Number Nine");
    const distilleries = await db.select().from(schema.distilleries);
    expect(distilleries).toHaveLength(1);
  });

  it("holds a scanned barcode on the submission rather than teaching the scanner", async () => {
    const { bottle } = await submitBottle(db, alice.id, {
      name: "Mystery Single Barrel",
      category: "bourbon",
      upc: "012345678905",
      source: "scan",
    });

    // A bottle_upcs row is what every other scanner resolves against, so it
    // may not point at a bottle only Alice can see.
    expect(await db.select().from(schema.bottleUpcs)).toHaveLength(0);
    const [submission] = await db
      .select()
      .from(schema.bottleSubmissions)
      .where(eq(schema.bottleSubmissions.bottleId, bottle.id));
    expect(submission.upc).toBe("012345678905");

    await publishSubmissionUpc(db, bottle.id, "012345678905");
    expect(await db.select().from(schema.bottleUpcs)).toHaveLength(1);
  });

  it("refuses once the hourly allowance is spent", async () => {
    for (let i = 0; i < SUBMISSION_LIMIT_PER_HOUR; i++) {
      await submitBottle(db, alice.id, { name: `Bottle ${i}`, category: "bourbon" });
    }
    await expect(
      submitBottle(db, alice.id, { name: "One too many", category: "bourbon" }),
    ).rejects.toBeInstanceOf(SubmissionRateLimitedError);

    // The limit is per account, not global — Bob is unaffected.
    await expect(
      submitBottle(db, bob.id, { name: "Bob's first", category: "bourbon" }),
    ).resolves.toBeTruthy();
  });

  it("counts only the last hour, so yesterday's additions don't block today's", async () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const yesterday = new Date("2026-09-02T12:00:00Z");
    for (let i = 0; i < SUBMISSION_LIMIT_PER_HOUR; i++) {
      const { submissionId } = await submitBottle(db, alice.id, {
        name: `Old ${i}`,
        category: "bourbon",
      });
      await db
        .update(schema.bottleSubmissions)
        .set({ createdAt: yesterday })
        .where(eq(schema.bottleSubmissions.id, submissionId));
    }
    await expect(
      submitBottle(db, alice.id, { name: "Today's", category: "bourbon" }, now),
    ).resolves.toBeTruthy();
  });
});

describe("catalog visibility", () => {
  it("keeps a submission out of everyone else's search", async () => {
    await createTestBottle(db, { name: "Eagle Rare 10", category: "bourbon" });
    await submitBottle(db, alice.id, { name: "Eagle Rare 17", category: "bourbon" });

    const mine = await searchBottles(db, "eagle", { viewerId: alice.id });
    expect(mine.map((b) => b.name).sort()).toEqual(["Eagle Rare 10", "Eagle Rare 17"]);

    const theirs = await searchBottles(db, "eagle", { viewerId: bob.id });
    expect(theirs.map((b) => b.name)).toEqual(["Eagle Rare 10"]);

    // Signed out is the same answer as "somebody else".
    const anonymous = await searchBottles(db, "eagle");
    expect(anonymous.map((b) => b.name)).toEqual(["Eagle Rare 10"]);
  });

  it("keeps a submission out of the browse list, which has no query to filter on", async () => {
    await createTestBottle(db, { name: "Wild Turkey 101", category: "bourbon" });
    await submitBottle(db, alice.id, { name: "Private Pick", category: "bourbon" });

    expect((await searchBottles(db, "")).map((b) => b.name)).toEqual(["Wild Turkey 101"]);
    expect((await searchBottles(db, "", { viewerId: alice.id })).map((b) => b.name)).toEqual([
      "Private Pick",
      "Wild Turkey 101",
    ]);
  });

  it("404s the detail of somebody else's submission and serves the submitter's own", async () => {
    const { bottle } = await submitBottle(db, alice.id, {
      name: "Alice's Barrel",
      category: "bourbon",
    });

    expect(await getBottleDetail(db, bottle.id, alice.id)).not.toBeNull();
    expect(await getBottleDetail(db, bottle.id, bob.id)).toBeNull();
    expect(await getBottleDetail(db, bottle.id)).toBeNull();
  });

  it("canViewBottle agrees with the SQL, including for a signed-out viewer", () => {
    const verified = { status: "verified" as const, submittedBy: null };
    const submitted = { status: "user_submitted" as const, submittedBy: alice.id };
    expect(canViewBottle(verified)).toBe(true);
    expect(canViewBottle(submitted)).toBe(false);
    expect(canViewBottle(submitted, alice.id)).toBe(true);
    expect(canViewBottle(submitted, bob.id)).toBe(false);
  });
});

describe("the concierge sees the same catalog the user does", () => {
  it("hides another user's submission from the AI search tool", async () => {
    const { searchBottlesLike } = await import("@/lib/ai/tools");
    await createTestBottle(db, { name: "Ardbeg Uigeadail", category: "scotch-single-malt" });
    await submitBottle(db, alice.id, { name: "Ardbeg Committee Bottling", category: "scotch-single-malt" });

    expect((await searchBottlesLike(db, "Ardbeg", undefined, 10, alice.id)).map((b) => b.name).sort()).toEqual([
      "Ardbeg Committee Bottling",
      "Ardbeg Uigeadail",
    ]);
    expect((await searchBottlesLike(db, "Ardbeg", undefined, 10, bob.id)).map((b) => b.name)).toEqual([
      "Ardbeg Uigeadail",
    ]);
  });

  it("hides one from the discovery recommender too", async () => {
    const { recommendBottles } = await import("@/lib/recommend");
    const { logPour } = await import("@/lib/pours");
    const profile = { sweet: 8, woody: 6, spicy: 3, fruity: 4 };

    // Bob needs a palate before anything can be recommended to him, so he
    // pours something from the shared catalog and rates it.
    const poured = await createTestBottle(db, {
      name: "Shared Bourbon",
      category: "bourbon",
      flavorProfile: profile,
    });
    await logPour(db, bob.id, { bottleId: poured.id, rating: 5 });

    // Alice's submission is the strongest possible match, so if visibility
    // were not enforced it would be at the top of Bob's list.
    const { bottle } = await submitBottle(db, alice.id, {
      name: "Alice's Barrel Pick",
      category: "bourbon",
    });
    await db
      .update(schema.bottles)
      .set({ flavorProfile: profile, avgPrice: 59.99 })
      .where(eq(schema.bottles.id, bottle.id));

    const forBob = await recommendBottles(db, bob.id, { mode: "discovery" });
    expect(forBob.map((r) => r.bottleId)).not.toContain(bottle.id);

    // And the other half of the rule: Alice, who added it, is recommended it
    // like any other bottle. Hidden from everyone else is not hidden from her.
    await logPour(db, alice.id, { bottleId: poured.id, rating: 5 });
    const forAlice = await recommendBottles(db, alice.id, { mode: "discovery" });
    expect(forAlice.map((r) => r.bottleId)).toContain(bottle.id);
  });
});

describe("duplicate detection", () => {
  it("finds an existing bottle before a second row for it exists", async () => {
    await createTestBottle(db, { name: "Blanton's Single Barrel", category: "bourbon" });
    const found = await findSubmissionDuplicates(db, alice.id, "Blantons Single Barrel");
    expect(found.map((b) => b.name)).toContain("Blanton's Single Barrel");
  });

  it("treats punctuation and case as noise, not as a different bottle", () => {
    expect(looksLikeDuplicate("Blantons Single Barrel", "Blanton's Single Barrel")).toBe(true);
    expect(looksLikeDuplicate("  eagle rare 10 ", "Eagle Rare 10")).toBe(true);
    expect(looksLikeDuplicate("Eagle Rare 17", "Eagle Rare 10")).toBe(false);
  });
});

describe("listOwnSubmissions", () => {
  it("returns this user's submissions and nobody else's", async () => {
    await submitBottle(db, alice.id, { name: "Alice One", category: "bourbon" });
    await submitBottle(db, bob.id, { name: "Bob One", category: "rye" });

    const mine = await listOwnSubmissions(db, alice.id);
    expect(mine.map((s) => s.name)).toEqual(["Alice One"]);
    expect(mine[0].state).toBe("pending");
  });
});
