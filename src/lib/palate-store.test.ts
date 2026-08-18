import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { getUserPalates } from "./palate-store";

describe("getUserPalates", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("computes every requested user's palate in one pass", async () => {
    const a = await createTestUser(db);
    const b = await createTestUser(db);
    const bottle = await createTestBottle(db, { flavorProfile: { peaty: 9 } });
    await db.insert(schema.pours).values([
      { id: uid("p"), userId: a.id, bottleId: bottle.id, rating: 5 },
      { id: uid("p"), userId: b.id, bottleId: bottle.id, rating: 5 },
    ]);

    const palates = await getUserPalates(db, [a.id, b.id]);
    expect(palates.get(a.id)?.ratedSampleSize).toBe(1);
    expect(palates.get(b.id)?.ratedSampleSize).toBe(1);
  });

  it("honours an authorization predicate on the pour rows", async () => {
    // A palate is a projection of everything someone logged, private pours
    // included, so callers reading OTHER people bind the permission check to
    // this query rather than to a list read beforehand.
    const permitted = await createTestUser(db);
    const notPermitted = await createTestUser(db);
    const bottle = await createTestBottle(db, { flavorProfile: { peaty: 9 } });
    await db.insert(schema.pours).values([
      { id: uid("p"), userId: permitted.id, bottleId: bottle.id, rating: 5 },
      { id: uid("p"), userId: notPermitted.id, bottleId: bottle.id, rating: 5 },
    ]);

    const palates = await getUserPalates(
      db,
      [permitted.id, notPermitted.id],
      undefined,
      eq(schema.pours.userId, permitted.id),
    );
    expect(palates.has(permitted.id)).toBe(true);
    // Absent, not empty — the caller reads that as "no palate", which is the
    // same answer it gives for someone who has never poured.
    expect(palates.has(notPermitted.id)).toBe(false);
  });
});
