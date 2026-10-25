import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET } from "@/app/api/notifications/route";
import { POST as READ } from "@/app/api/notifications/read/route";
import { GET as GET_SETTINGS, PATCH } from "@/app/api/notifications/settings/route";
import { GET as FEED } from "@/app/api/feed/route";
import { createProfile } from "@/lib/social";
import { notify } from "@/lib/notify";

describe("/api/notifications, /api/feed", () => {
  let db: DB;
  let me: schema.User;
  let other: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    me = await createTestUser(db, { name: "Me" });
    other = await createTestUser(db, { name: "Other" });
    await createProfile(db, me, "me_api");
    await createProfile(db, other, "other_api");
    setSessionUser(me);
  });

  it("401s when signed out", async () => {
    setSessionUser(null);
    expect((await GET(jsonRequest("/api/notifications", "GET"))).status).toBe(401);
    expect((await READ(jsonRequest("/api/notifications/read", "POST", {}))).status).toBe(401);
    expect((await GET_SETTINGS()).status).toBe(401);
    expect((await PATCH(jsonRequest("/api/notifications/settings", "PATCH", {}))).status).toBe(401);
    expect((await FEED(jsonRequest("/api/feed", "GET"))).status).toBe(401);
  });

  it("lists the inbox with an unread count and marks read", async () => {
    await notify(db, { recipientId: me.id, actorId: other.id, category: "cheer", subjectId: "p1", dedupeKey: "a" });
    await notify(db, { recipientId: other.id, actorId: me.id, category: "cheer", subjectId: "p2", dedupeKey: "b" });
    const res = await GET(jsonRequest("/api/notifications", "GET"));
    const body = await res.json();
    expect(body.unread).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ text: "@other_api cheered your note", deepLink: "/notes/p1", read: false });

    expect((await READ(jsonRequest("/api/notifications/read", "POST", { ids: "nope" }))).status).toBe(400);
    const read = await READ(jsonRequest("/api/notifications/read", "POST", {}));
    expect(await read.json()).toEqual({ marked: 1 });
    // The other person's row is untouched.
    const theirs = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, other.id));
    expect(theirs[0].readAt).toBeNull();
  });

  it("400s on a bad before or cursor", async () => {
    expect((await GET(jsonRequest("/api/notifications?before=junk", "GET"))).status).toBe(400);
    expect((await FEED(jsonRequest("/api/feed?cursor=junk", "GET"))).status).toBe(400);
  });

  it("reads and patches settings, rejecting unknown groups and lone bounds", async () => {
    const initial = await (await GET_SETTINGS()).json();
    expect(initial).toMatchObject({ pushEnabled: true, quietStart: null, pushAvailable: false });
    expect((await PATCH(jsonRequest("/api/notifications/settings", "PATCH", { groups: { bogus: true } }))).status).toBe(400);
    expect((await PATCH(jsonRequest("/api/notifications/settings", "PATCH", { quietStart: 10 }))).status).toBe(400);
    expect((await PATCH(jsonRequest("/api/notifications/settings", "PATCH", { extra: 1 }))).status).toBe(400);
    const ok = await PATCH(
      jsonRequest("/api/notifications/settings", "PATCH", { groups: { cheers: false }, quietStart: 1320, quietEnd: 420, timeZone: "Europe/London" }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ quietStart: 1320, quietEnd: 420, timeZone: "Europe/London", groups: { cheers: false, comments: true } });
  });

  it("returns an empty feed page with no cursor for someone who follows nobody", async () => {
    const res = await FEED(jsonRequest("/api/feed", "GET"));
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });
});
