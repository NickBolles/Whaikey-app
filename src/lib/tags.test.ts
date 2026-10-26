import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb } from "@/test/helpers";
import { listPours, logPour } from "@/lib/pours";
import { cleanTag, listTagSuggestions, normalizeTags, setPourTags, tagsForPours } from "@/lib/tags";

describe("tag rules", () => {
  it("cleans a tag to a label", () => {
    expect(cleanTag("  #Tasting   Night ")).toBe("Tasting Night");
    expect(cleanTag("   ")).toBeNull();
    expect(cleanTag("#")).toBeNull();
    expect(cleanTag("x".repeat(80))).toHaveLength(32);
  });

  it("de-duplicates case-insensitively, first spelling wins, and caps at ten", () => {
    expect(normalizeTags(["Gift", "gift ", "#GIFT", "blind"])).toEqual(["Gift", "blind"]);
    expect(normalizeTags(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
  });
});

describe("tags in the journal", () => {
  let db: DB;
  let alice: schema.User;
  let bob: schema.User;
  let bottle: schema.Bottle;

  beforeEach(async () => {
    db = await setupTestDb();
    alice = await createTestUser(db);
    bob = await createTestUser(db);
    bottle = await createTestBottle(db, { name: "Tag Bourbon" });
  });

  it("logPour files tags, reuses an existing tag by key, and listPours returns them", async () => {
    const first = await logPour(db, alice.id, { bottleId: bottle.id, tags: ["Tasting night", "gift"] });
    const second = await logPour(db, alice.id, { bottleId: bottle.id, tags: ["tasting NIGHT"] });
    expect(await db.query.tags.findMany({ where: (t, { eq }) => eq(t.userId, alice.id) })).toHaveLength(2);
    const listed = await listPours(db, alice.id);
    const byId = new Map(listed.map((p) => [p.id, p.tags]));
    expect(byId.get(first.pour.id)).toEqual(["Tasting night", "gift"]);
    // The spelling first used is kept.
    expect(byId.get(second.pour.id)).toEqual(["Tasting night"]);
  });

  it("suggests only the user's own tags, most used first", async () => {
    await logPour(db, alice.id, { bottleId: bottle.id, tags: ["blind"] });
    await logPour(db, alice.id, { bottleId: bottle.id, tags: ["blind", "gift"] });
    await logPour(db, bob.id, { bottleId: bottle.id, tags: ["bob-secret"] });
    expect(await listTagSuggestions(db, alice.id)).toEqual([
      { name: "blind", uses: 2 },
      { name: "gift", uses: 1 },
    ]);
    expect((await listTagSuggestions(db, bob.id)).map((t) => t.name)).toEqual(["bob-secret"]);
  });

  it("setPourTags replaces a pour's tags, and others' pours read as untagged", async () => {
    const { pour } = await logPour(db, alice.id, { bottleId: bottle.id, tags: ["a", "b"] });
    expect(await setPourTags(db, alice.id, pour.id, ["b", "c"])).toEqual(["b", "c"]);
    expect((await tagsForPours(db, alice.id, [pour.id])).get(pour.id)).toEqual(["b", "c"]);
    expect((await tagsForPours(db, bob.id, [pour.id])).get(pour.id)).toBeUndefined();
  });

  it("deleting a pour drops its tag links but keeps the tag for suggestions", async () => {
    const { deletePour } = await import("@/lib/pours");
    const { pour } = await logPour(db, alice.id, { bottleId: bottle.id, tags: ["gift"] });
    await deletePour(db, alice.id, pour.id);
    expect(await db.query.pourTags.findMany()).toHaveLength(0);
    expect(await listTagSuggestions(db, alice.id)).toEqual([{ name: "gift", uses: 0 }]);
  });
});
