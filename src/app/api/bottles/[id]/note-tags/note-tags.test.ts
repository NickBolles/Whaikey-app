import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import {
  createTestBottle,
  createTestUser,
  jsonRequest,
  mockSessionModule,
  setSessionUser,
  setupTestDb,
  uid,
} from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { POST } from "@/app/api/bottles/[id]/note-tags/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/bottles/[id]/note-tags", () => {
  let db: DB;
  let user: schema.User;
  let bottle: schema.Bottle;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db);
    bottle = await createTestBottle(db, { name: "Tagged Bourbon" });
    setSessionUser(user);
  });

  async function seedPour(createdAt: string, withNote?: Record<string, number>) {
    const [pour] = await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: user.id, bottleId: bottle.id, createdAt: new Date(createdAt) })
      .returning();
    if (withNote) {
      await db.insert(schema.tastingNotes).values({ id: uid("note"), pourId: pour.id, flavorTags: withNote });
    }
    return pour;
  }

  const post = (leafId: string) =>
    POST(jsonRequest(`/api/bottles/${bottle.id}/note-tags`, "POST", { leafId }), ctx(bottle.id));

  it("401 signed out, 400 for an id off the wheel, 404 with no pour to note", async () => {
    setSessionUser(null);
    expect((await post("oak")).status).toBe(401);
    setSessionUser(user);
    expect((await post("not-a-flavor")).status).toBe(400);
    expect((await post("oak")).status).toBe(404);
  });

  it("adds the flavor at intensity 1 to the latest pour's note", async () => {
    await seedPour("2026-07-01T12:00:00Z", { vanilla: 2 });
    const latest = await seedPour("2026-07-10T12:00:00Z", { campfire: 3 });

    const res = await post("brine");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ pourId: latest.id, flavorTags: { campfire: 3, brine: 1 } });
  });

  it("creates the tasting note when the latest pour has none", async () => {
    const pour = await seedPour("2026-07-10T12:00:00Z");
    const res = await post("honey");
    expect(res.status).toBe(200);
    const note = await db.query.tastingNotes.findFirst({
      where: eq(schema.tastingNotes.pourId, pour.id),
    });
    expect(note?.flavorTags).toEqual({ honey: 1 });
    expect(note?.extractedBy).toBe("user");
  });

  it("never lowers an intensity the user already set", async () => {
    await seedPour("2026-07-10T12:00:00Z", { peat: 3 });
    const res = await post("peat");
    const body = await res.json();
    expect(body.flavorTags).toEqual({ peat: 3 });
  });

  it("ignores other users' pours of the same bottle", async () => {
    const other = await createTestUser(db);
    await db
      .insert(schema.pours)
      .values({ id: uid("pour"), userId: other.id, bottleId: bottle.id });
    expect((await post("oak")).status).toBe(404);
  });
});
