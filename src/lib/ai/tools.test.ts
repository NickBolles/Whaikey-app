import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { executeTool, searchBottlesLike } from "./tools";

let db: DB;
let user: schema.User;

beforeEach(async () => {
  db = setupTestDb();
  user = await createTestUser(db);
});

describe("search_bottles", () => {
  it("finds bottles by name (case-insensitive LIKE)", async () => {
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10 Year" });
    const result = (await executeTool(db, user.id, "search_bottles", {
      query: "eagle rare",
    })) as { results: Array<{ id: string }> };
    expect(result.results.map((r) => r.id)).toContain(bottle.id);
  });

  it("finds bottles via alias", async () => {
    const bottle = await createTestBottle(db, { name: "W.L. Weller Special Reserve" });
    await db
      .insert(schema.bottleAliases)
      .values({ id: uid("alias"), bottleId: bottle.id, alias: "Weller Green Label" });
    const result = (await executeTool(db, user.id, "search_bottles", {
      query: "green label",
    })) as { results: Array<{ id: string; name: string }> };
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe(bottle.id);
  });

  it("filters by category", async () => {
    await createTestBottle(db, { name: "Highland Dram", category: "scotch-single-malt" });
    const bourbon = await createTestBottle(db, { name: "Highland Bourbon", category: "bourbon" });
    const result = (await executeTool(db, user.id, "search_bottles", {
      query: "highland",
      category: "bourbon",
    })) as { results: Array<{ id: string }> };
    expect(result.results.map((r) => r.id)).toEqual([bourbon.id]);
  });

  it("caps results at 10", async () => {
    for (let i = 0; i < 12; i++) {
      await createTestBottle(db, { name: `Cask Strength Batch ${i}` });
    }
    const rows = await searchBottlesLike(db, "Cask Strength");
    expect(rows).toHaveLength(10);
  });

  it("returns {error} on invalid input", async () => {
    const result = (await executeTool(db, user.id, "search_bottles", {})) as { error?: string };
    expect(result.error).toBeTruthy();
  });
});

describe("get_bottle_details", () => {
  it("returns bottle, distillery, and community average rating", async () => {
    const [distillery] = await db
      .insert(schema.distilleries)
      .values({ id: uid("dist"), name: "Buffalo Trace Distillery", country: "USA" })
      .returning();
    const bottle = await createTestBottle(db, { distilleryId: distillery.id });
    const otherUser = await createTestUser(db);
    await db.insert(schema.pours).values([
      { id: uid("pour"), userId: user.id, bottleId: bottle.id, rating: 4 },
      { id: uid("pour"), userId: otherUser.id, bottleId: bottle.id, rating: 5 },
    ]);

    const result = (await executeTool(db, user.id, "get_bottle_details", {
      bottleId: bottle.id,
    })) as {
      bottle: { id: string };
      distillery: { name: string };
      communityAvgRating: number;
      communityRatingCount: number;
    };
    expect(result.bottle.id).toBe(bottle.id);
    expect(result.distillery.name).toBe("Buffalo Trace Distillery");
    expect(result.communityAvgRating).toBe(4.5);
    expect(result.communityRatingCount).toBe(2);
  });

  it("returns {error} for an unknown bottle id", async () => {
    const result = (await executeTool(db, user.id, "get_bottle_details", {
      bottleId: "nope",
    })) as { error?: string };
    expect(result.error).toMatch(/no bottle/i);
  });
});

describe("get_my_bar", () => {
  it("is scoped to the user and defaults to owned bottles", async () => {
    const otherUser = await createTestUser(db);
    const mine = await createTestBottle(db, { name: "My Bottle" });
    const wished = await createTestBottle(db, { name: "Wish Bottle" });
    const theirs = await createTestBottle(db, { name: "Their Bottle" });
    await db.insert(schema.userBottles).values([
      { id: uid("ub"), userId: user.id, bottleId: mine.id, relationship: "own" },
      { id: uid("ub"), userId: user.id, bottleId: wished.id, relationship: "wishlist" },
      { id: uid("ub"), userId: otherUser.id, bottleId: theirs.id, relationship: "own" },
    ]);

    const owned = (await executeTool(db, user.id, "get_my_bar", {})) as {
      relationship: string;
      bottles: Array<{ bottleName: string }>;
    };
    expect(owned.relationship).toBe("own");
    expect(owned.bottles.map((b) => b.bottleName)).toEqual(["My Bottle"]);

    const wishlist = (await executeTool(db, user.id, "get_my_bar", {
      relationship: "wishlist",
    })) as { bottles: Array<{ bottleName: string }> };
    expect(wishlist.bottles.map((b) => b.bottleName)).toEqual(["Wish Bottle"]);
  });
});

describe("get_pour_history", () => {
  it("returns the user's pours with note snippets, newest first", async () => {
    const bottle = await createTestBottle(db);
    const [oldPour] = await db
      .insert(schema.pours)
      .values({
        id: uid("pour"),
        userId: user.id,
        bottleId: bottle.id,
        rating: 3.5,
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: oldPour.id,
      freeform: "Big vanilla and toasted oak with a long cinnamon finish",
    });
    await db.insert(schema.pours).values({
      id: uid("pour"),
      userId: user.id,
      bottleId: bottle.id,
      rating: 4.5,
    });

    const result = (await executeTool(db, user.id, "get_pour_history", {})) as {
      pours: Array<{ rating: number | null; noteSnippet: string | null }>;
    };
    expect(result.pours).toHaveLength(2);
    expect(result.pours[0].rating).toBe(4.5);
    expect(result.pours[1].noteSnippet).toMatch(/vanilla/);
  });
});

describe("get_tasting_notes", () => {
  it("returns the user's notes for a bottle", async () => {
    const bottle = await createTestBottle(db);
    const [pour] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: bottle.id, rating: 4 })
      .returning();
    await db.insert(schema.tastingNotes).values({
      id: uid("note"),
      pourId: pour.id,
      nose: "Honey and orchard fruit",
      flavorTags: { honey: 2, "green-apple": 1 },
    });

    const result = (await executeTool(db, user.id, "get_tasting_notes", {
      bottleId: bottle.id,
    })) as { notes: Array<{ nose: string; flavorTags: Record<string, number> }> };
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].nose).toBe("Honey and orchard fruit");
    expect(result.notes[0].flavorTags.honey).toBe(2);
  });

  it("returns {error} for an unknown bottle", async () => {
    const result = (await executeTool(db, user.id, "get_tasting_notes", {
      bottleId: "missing",
    })) as { error?: string };
    expect(result.error).toBeTruthy();
  });
});

describe("add_to_wishlist", () => {
  it("adds a wishlist row and is idempotent", async () => {
    const bottle = await createTestBottle(db);

    const first = (await executeTool(db, user.id, "add_to_wishlist", {
      bottleId: bottle.id,
    })) as { status: string };
    expect(first.status).toBe("added_to_wishlist");

    const second = (await executeTool(db, user.id, "add_to_wishlist", {
      bottleId: bottle.id,
    })) as { status: string; relationship: string };
    expect(second.status).toBe("already_in_bar");
    expect(second.relationship).toBe("wishlist");

    const rows = await db
      .select()
      .from(schema.userBottles)
      .where(
        and(eq(schema.userBottles.userId, user.id), eq(schema.userBottles.bottleId, bottle.id)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].relationship).toBe("wishlist");
  });

  it("does not downgrade an owned bottle", async () => {
    const bottle = await createTestBottle(db);
    await db.insert(schema.userBottles).values({
      id: uid("ub"),
      userId: user.id,
      bottleId: bottle.id,
      relationship: "own",
    });
    const result = (await executeTool(db, user.id, "add_to_wishlist", {
      bottleId: bottle.id,
    })) as { status: string; relationship: string };
    expect(result.status).toBe("already_in_bar");
    expect(result.relationship).toBe("own");
  });

  it("returns {error} for an unknown bottle", async () => {
    const result = (await executeTool(db, user.id, "add_to_wishlist", {
      bottleId: "missing",
    })) as { error?: string };
    expect(result.error).toBeTruthy();
  });
});

describe("dispatcher", () => {
  it("returns {error} for an unknown tool name", async () => {
    const result = (await executeTool(db, user.id, "launch_rockets", {})) as { error?: string };
    expect(result.error).toMatch(/unknown tool/i);
  });
});
