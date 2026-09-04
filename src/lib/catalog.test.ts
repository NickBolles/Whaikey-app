import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { setupTestDb, createTestBottle, createTestUser, uid } from "@/test/helpers";
import {
  DuplicateBottleError,
  SUBMISSION_LIMIT_PER_HOUR,
  SubmissionRateLimitedError,
  findSubmissionDuplicates,
  listOwnSubmissions,
  looksLikeDuplicate,
  publishSubmissionUpc,
  submitBottle,
  UnknownSubmissionError,
  approveSubmission,
  countPendingSubmissions,
  listPendingSubmissions,
  markSubmissionDuplicate,
  rejectSubmission,
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
  /**
   * Two identical requests arriving together used to clear a duplicate check
   * made outside the write's lock and then insert one after the other. The
   * prompt has to be in the same critical section as the insert.
   */
  it("refuses a name already in the catalog, from inside the write's lock", async () => {
    await createTestBottle(db, { name: "Blanton's Single Barrel", category: "bourbon" });
    await expect(
      submitBottle(db, alice.id, { name: "Blantons Single Barrel", category: "bourbon" }),
    ).rejects.toBeInstanceOf(DuplicateBottleError);
    expect(await db.select().from(schema.bottleSubmissions)).toHaveLength(0);

    await expect(
      submitBottle(db, alice.id, {
        name: "Blantons Single Barrel",
        category: "bourbon",
        confirmNew: true,
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses a second identical submission from the same account", async () => {
    await submitBottle(db, alice.id, { name: "Faraway Farm Pick", category: "bourbon" });
    // The first submission is itself in the catalog the check searches, so the
    // duplicate prompt covers a double-tap as well as a real collision.
    await expect(
      submitBottle(db, alice.id, { name: "Faraway Farm Pick", category: "bourbon" }),
    ).rejects.toBeInstanceOf(DuplicateBottleError);
  });

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

describe("a pour of an unreviewed bottle", () => {
  /**
   * The submission is the submitter's alone, but a pour of it is not only a
   * pour: the friend feed, a shared note and a profile's recent notes all join
   * the bottle for its name and none of them checks its status. A public pour
   * would publish the bottle through the side door.
   */
  it("is private whatever was asked for, and stays that way after promotion", async () => {
    const { logPour } = await import("@/lib/pours");
    const { bottle } = await submitBottle(db, alice.id, {
      name: "Alice's Barrel Pick",
      category: "bourbon",
    });

    const { pour } = await logPour(db, alice.id, { bottleId: bottle.id, visibility: "public" });
    expect(pour.visibility).toBe("private");

    // Promotion does not raise it: the system never raises a visibility, and
    // its owner can publish the note themselves once the bottle is shared.
    await db
      .update(schema.bottles)
      .set({ status: "verified" })
      .where(eq(schema.bottles.id, bottle.id));
    const [stored] = await db
      .select()
      .from(schema.pours)
      .where(eq(schema.pours.id, pour.id));
    expect(stored.visibility).toBe("private");

    // A pour of an ordinary catalog bottle is untouched.
    const shared = await createTestBottle(db, { name: "Shared Rye", category: "rye" });
    const other = await logPour(db, alice.id, { bottleId: shared.id, visibility: "public" });
    expect(other.pour.visibility).toBe("public");
  });

  /**
   * Holding it private at write time is only half the door. The owner can
   * come back later and publish the note, or mint a bearer link to it — both
   * of which render the bottle's name to someone else.
   */
  it("cannot be published or shared after the fact either", async () => {
    const { logPour, updatePourVisibility, PendingBottleError } = await import("@/lib/pours");
    const { createPourShare } = await import("@/lib/pour-sharing");
    const { bottle } = await submitBottle(db, alice.id, {
      name: "Alice's Barrel Pick",
      category: "bourbon",
    });
    const { pour } = await logPour(db, alice.id, { bottleId: bottle.id });

    await expect(
      updatePourVisibility(db, alice.id, pour.id, "public"),
    ).rejects.toBeInstanceOf(PendingBottleError);
    await expect(createPourShare(db, alice.id, pour.id)).rejects.toBeInstanceOf(
      PendingBottleError,
    );
    // Setting it private is always allowed — nothing here traps a note.
    await expect(updatePourVisibility(db, alice.id, pour.id, "private")).resolves.toBeTruthy();

    // Once the bottle is shared, its owner can publish the note themselves.
    await db
      .update(schema.bottles)
      .set({ status: "verified" })
      .where(eq(schema.bottles.id, bottle.id));
    await expect(updatePourVisibility(db, alice.id, pour.id, "public")).resolves.toMatchObject({
      visibility: "public",
    });
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

/**
 * WP-16 left the far end of the submission path open: rows piled up and
 * nothing could promote one, so a submitted bottle was private forever and the
 * "once someone has checked it over" copy promised a review nobody could do.
 */
describe("catalog review", () => {
  it("lists what is waiting, oldest first, with the typed distillery kept apart", async () => {
    await submitBottle(db, alice.id, {
      name: "Older One",
      category: "bourbon",
      distillery: "A Distillery Nobody Has",
    });
    await submitBottle(db, bob.id, { name: "Newer One", category: "rye" });
    // Age the first so the ordering assertion is about createdAt, not insert order.
    await db
      .update(schema.bottleSubmissions)
      .set({ createdAt: new Date(Date.now() - 5 * 3_600_000) })
      .where(eq(schema.bottleSubmissions.submittedBy, alice.id));

    const pending = await listPendingSubmissions(db);
    expect(pending.map((s) => s.name)).toEqual(["Older One", "Newer One"]);
    expect(pending[0].ageHours).toBeGreaterThanOrEqual(5);
    expect(pending[0].distilleryText).toBe("A Distillery Nobody Has");
    expect(pending[0].distilleryName).toBeNull();
    expect(await countPendingSubmissions(db)).toBe(2);
  });

  it("approving makes the bottle everyone's and publishes its barcode", async () => {
    const { bottle, submissionId } = await submitBottle(db, alice.id, {
      name: "Approve Me",
      category: "bourbon",
      upc: "012345678912",
    });
    // Held back until a human looked: bottle_upcs is what every other scan
    // resolves against.
    expect(await db.select().from(schema.bottleUpcs)).toHaveLength(0);
    expect(canViewBottle(bottle, bob.id)).toBe(false);

    await approveSubmission(db, bob.id, submissionId, "looks real");

    const after = await db.query.bottles.findFirst({ where: eq(schema.bottles.id, bottle.id) });
    expect(after?.status).toBe("verified");
    expect(canViewBottle(after!, bob.id)).toBe(true);
    const upcs = await db.select().from(schema.bottleUpcs);
    expect(upcs).toHaveLength(1);
    expect(upcs[0]).toMatchObject({ upc: "012345678912", bottleId: bottle.id, source: "user" });

    const row = await db.query.bottleSubmissions.findFirst({
      where: eq(schema.bottleSubmissions.id, submissionId),
    });
    expect(row).toMatchObject({ state: "approved", reviewedBy: bob.id, reviewNote: "looks real" });
    expect(row?.reviewedAt).toBeInstanceOf(Date);
  });

  it("approving does not raise the visibility of a pour logged while it was pending", async () => {
    const { bottle, submissionId } = await submitBottle(db, alice.id, {
      name: "Clamped",
      category: "bourbon",
    });
    const { logPour } = await import("@/lib/pours");
    const { pour } = await logPour(db, alice.id, { bottleId: bottle.id, visibility: "public" });
    expect(pour.visibility).toBe("private");

    await approveSubmission(db, bob.id, submissionId);

    const after = await db.query.pours.findFirst({ where: eq(schema.pours.id, pour.id) });
    // The system never raises a visibility. Its owner can publish it now.
    expect(after?.visibility).toBe("private");
  });

  it("a second operator on the same row changes nothing and is told so", async () => {
    const { submissionId } = await submitBottle(db, alice.id, {
      name: "Race Me",
      category: "bourbon",
    });
    await approveSubmission(db, bob.id, submissionId);
    await expect(approveSubmission(db, bob.id, submissionId)).rejects.toBeInstanceOf(
      UnknownSubmissionError,
    );
    await expect(rejectSubmission(db, bob.id, submissionId, "no")).rejects.toBeInstanceOf(
      UnknownSubmissionError,
    );
  });

  it("declining keeps the bottle working for the person who added it", async () => {
    const { bottle, submissionId } = await submitBottle(db, alice.id, {
      name: "Decline Me",
      category: "bourbon",
    });
    await rejectSubmission(db, bob.id, submissionId, "already listed under another name");

    const after = await db.query.bottles.findFirst({ where: eq(schema.bottles.id, bottle.id) });
    // Not deleted, not taken away: their own records stay theirs.
    expect(after?.status).toBe("user_submitted");
    expect(canViewBottle(after!, alice.id)).toBe(true);
    expect(canViewBottle(after!, bob.id)).toBe(false);
    const row = await db.query.bottleSubmissions.findFirst({
      where: eq(schema.bottleSubmissions.id, submissionId),
    });
    expect(row).toMatchObject({
      state: "rejected",
      reviewNote: "already listed under another name",
    });
  });

  it("refuses to record a duplicate of a bottle nobody can see", async () => {
    const other = await submitBottle(db, bob.id, { name: "Also Pending", category: "rye" });
    const { submissionId } = await submitBottle(db, alice.id, {
      name: "Dupe Me",
      category: "bourbon",
    });

    await expect(
      markSubmissionDuplicate(db, bob.id, submissionId, other.bottle.id, undefined),
    ).rejects.toBeInstanceOf(UnknownSubmissionError);

    const canonical = await createTestBottle(db, { name: "The Real One", category: "bourbon" });
    await markSubmissionDuplicate(db, bob.id, submissionId, canonical.id, "same bottle");
    const row = await db.query.bottleSubmissions.findFirst({
      where: eq(schema.bottleSubmissions.id, submissionId),
    });
    expect(row).toMatchObject({ state: "duplicate", duplicateOfBottleId: canonical.id });
  });
});

/**
 * The strongest version of the same defect: `bottles.submittedBy` had no
 * delete policy either, so submitting a single bottle made an ordinary account
 * permanently undeletable — a deletion right revoked by a foreign key. The
 * bottle is catalog data other people's shelves point at, so it stays; the
 * attribution is what goes.
 */
describe("a submitter can be deleted", () => {
  it("keeps the bottle and its review record, and drops only the attribution", async () => {
    const db = await setupTestDb();
    const submitter = await createTestUser(db);
    const reviewer = await createTestUser(db);
    const bottle = await createTestBottle(db, { status: "user_submitted", submittedBy: submitter.id });
    const submissionId = crypto.randomUUID();
    await db.insert(schema.bottleSubmissions).values({
      id: submissionId,
      bottleId: bottle.id,
      submittedBy: submitter.id,
      source: "search",
    });
    await approveSubmission(db, reviewer.id, submissionId, "checked against the distillery site");

    // The reviewer goes first: their decision is not theirs to take away.
    await db.delete(schema.user).where(eq(schema.user.id, reviewer.id));
    const reviewed = await db.query.bottleSubmissions.findFirst({
      where: eq(schema.bottleSubmissions.id, submissionId),
    });
    // `state`, not `reviewedBy`, is what says a submission is still pending —
    // so clearing the reviewer cannot put a decided row back in the queue.
    expect(reviewed?.state).toBe("approved");
    expect(reviewed?.reviewedBy).toBeNull();
    expect(reviewed?.reviewNote).toBe("checked against the distillery site");
    expect(await countPendingSubmissions(db)).toBe(0);

    // The submitter goes second. Their submission is a request they made, so it
    // cascades away with them — but the bottle it produced is now catalog data
    // other people's shelves point at, and only the attribution goes.
    await db.delete(schema.user).where(eq(schema.user.id, submitter.id));
    const kept = await db.query.bottles.findFirst({ where: eq(schema.bottles.id, bottle.id) });
    expect(kept?.status).toBe("verified");
    expect(kept?.submittedBy).toBeNull();
    expect(
      await db.query.bottleSubmissions.findFirst({
        where: eq(schema.bottleSubmissions.id, submissionId),
      }),
    ).toBeUndefined();
  });
});
