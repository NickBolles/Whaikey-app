import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, setupTestDb } from "@/test/helpers";
import { getSocialPrefs, seedNewAccountPrefs, updateSocialPrefs } from "@/lib/social";

describe("new-account pour visibility (owner decision D19 / D2 amended)", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("a new account defaults to Friends; an existing account with no prefs row stays Only me", async () => {
    const existing = await createTestUser(db);
    const fresh = await createTestUser(db);
    await seedNewAccountPrefs(db, fresh.id);
    expect((await getSocialPrefs(db, fresh.id)).defaultPourVisibility).toBe("friends");
    expect((await getSocialPrefs(db, existing.id)).defaultPourVisibility).toBe("private");
  });

  it("never overwrites a preference that already exists, and Settings can still change it", async () => {
    const u = await createTestUser(db);
    await db.insert(schema.userSocialPrefs).values({ userId: u.id, defaultPourVisibility: "private" });
    await seedNewAccountPrefs(db, u.id);
    expect((await getSocialPrefs(db, u.id)).defaultPourVisibility).toBe("private");
    const v = await createTestUser(db);
    await seedNewAccountPrefs(db, v.id);
    await updateSocialPrefs(db, v.id, { defaultPourVisibility: "private" });
    expect((await getSocialPrefs(db, v.id)).defaultPourVisibility).toBe("private");
  });

  it("is wired into Better Auth's user.create hook", async () => {
    const { auth } = await import("@/lib/auth");
    const u = await createTestUser(db);
    const hook = (auth.options.databaseHooks as { user: { create: { after: (u: { id: string }) => Promise<void> } } }).user.create.after;
    await hook({ id: u.id });
    expect((await getSocialPrefs(db, u.id)).defaultPourVisibility).toBe("friends");
  });
});
