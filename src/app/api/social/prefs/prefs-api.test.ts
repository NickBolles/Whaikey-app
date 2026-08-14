import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { GET, PATCH } from "@/app/api/social/prefs/route";
import { POST as PRIVACY_RESET } from "@/app/api/social/privacy-reset/route";
import { POST as REPORT } from "@/app/api/social/reports/route";
import { createProfile } from "@/lib/social";
import { logPour } from "@/lib/pours";

describe("/api/social/prefs", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db, { name: "Prefs User" });
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await GET()).status).toBe(401);
    expect((await PATCH(jsonRequest("/api/social/prefs", "PATCH", {}))).status).toBe(401);
  });

  it("GET returns defaults for a user with no prefs row", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ defaultPourVisibility: "private", allowComments: true });
  });

  it("PATCH updates prefs and persists them", async () => {
    const res = await PATCH(jsonRequest("/api/social/prefs", "PATCH", { defaultPourVisibility: "friends" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ defaultPourVisibility: "friends", allowComments: true });

    const reread = await GET();
    expect((await reread.json()).defaultPourVisibility).toBe("friends");
  });

  it("PATCH rejects an invalid visibility with 400", async () => {
    const res = await PATCH(jsonRequest("/api/social/prefs", "PATCH", { defaultPourVisibility: "loud" }));
    expect(res.status).toBe(400);
  });
});

describe("/api/social/privacy-reset", () => {
  let db: DB;
  let user: schema.User;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db, { name: "Reset User" });
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect((await PRIVACY_RESET()).status).toBe(401);
  });

  it("makes everything private and returns { done: true }", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "resetuser");
    await db.update(schema.userProfiles).set({ isPublic: true, discoverable: true }).where(eq(schema.userProfiles.userId, user.id));
    const bottle = await createTestBottle(db);
    await logPour(db, user.id, { bottleId: bottle.id, rating: 4, visibility: "public" });

    const res = await PRIVACY_RESET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });

    const profile = await db.query.userProfiles.findFirst({ where: eq(schema.userProfiles.userId, user.id) });
    expect(profile?.isPublic).toBe(false);
    expect(profile?.discoverable).toBe(false);
    expect(profile?.socialEnabled).toBe(false);

    const pours = await db.query.pours.findMany({ where: eq(schema.pours.userId, user.id) });
    expect(pours.every((p) => p.visibility === "private")).toBe(true);
  });
});

describe("/api/social/reports", () => {
  let db: DB;
  let user: schema.User;
  let author: schema.User;
  let pourId: string;

  beforeEach(async () => {
    db = await setupTestDb();
    user = await createTestUser(db, { name: "Reporter" });
    author = await createTestUser(db, { name: "Reported" });
    // The reported subject must be VISIBLE to the reporter: a profile-less
    // author's pours never surface socially, so give the author a profile.
    await createProfile(db, { id: author.id, name: author.name }, "reported_author");
    const bottle = await createTestBottle(db);
    const { pour } = await logPour(db, author.id, { bottleId: bottle.id, rating: 3, visibility: "public" });
    pourId = pour.id;
    setSessionUser(user);
  });

  it("returns 401 when signed out", async () => {
    setSessionUser(null);
    expect(
      (await REPORT(jsonRequest("/api/social/reports", "POST", { subjectType: "pour", subjectId: pourId, reason: "spam" })))
        .status,
    ).toBe(401);
  });

  it("works without a profile — reporting is a safety action (§11)", async () => {
    const res = await REPORT(
      jsonRequest("/api/social/reports", "POST", { subjectType: "pour", subjectId: pourId, reason: "spam" }),
    );
    expect(res.status).toBe(201);
  });

  it("returns 400 for an invalid body", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "reporter");
    const res = await REPORT(jsonRequest("/api/social/reports", "POST", { subjectType: "bogus", subjectId: pourId, reason: "x" }));
    expect(res.status).toBe(400);
  });

  it("creates a report and returns 201", async () => {
    await createProfile(db, { id: user.id, name: user.name }, "reporter");
    const res = await REPORT(
      jsonRequest("/api/social/reports", "POST", { subjectType: "pour", subjectId: pourId, reason: "spam" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await db.query.reports.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: "pour", subjectId: pourId, reporterId: user.id, reason: "spam" });
  });
});
