import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb, uid } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { createProfile } from "@/lib/social";
import { getWrapped, wrappedAvailable } from "@/lib/wrapped";
import { cardPath, signCard, verifyCard } from "@/lib/cards";
import { POST as MINT } from "@/app/api/cards/route";
import { GET as CARD } from "@/app/api/cards/[kind]/route";

describe("Wrapped", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("opens December 10 for the current year; past years are always open", () => {
    expect(wrappedAvailable(2026, new Date("2026-12-09T23:00:00Z"))).toBe(false);
    expect(wrappedAvailable(2026, new Date("2026-12-10T00:00:00Z"))).toBe(true);
    expect(wrappedAvailable(2025, new Date("2026-03-01T00:00:00Z"))).toBe(true);
    expect(wrappedAvailable(2027, new Date("2026-12-31T00:00:00Z"))).toBe(false);
  });

  it("counts only what was discovered this year, never how much", async () => {
    const me = await createTestUser(db);
    const islayOld = await createTestBottle(db, { name: "Old Islay", country: "Scotland", region: "Islay" });
    const islayNew = await createTestBottle(db, { name: "New Islay", country: "Scotland", region: "Islay" });
    const kentucky = await createTestBottle(db, { name: "Kentucky", country: "United States", region: "Kentucky" });
    const old = new Date("2025-06-01T00:00:00Z");
    const t = new Date("2026-06-01T00:00:00Z");
    await db.insert(schema.pours).values([
      { id: uid("p"), userId: me.id, bottleId: islayOld.id, createdAt: old, rating: 3 },
      { id: uid("p"), userId: me.id, bottleId: islayNew.id, createdAt: t, rating: 4 },
      ...Array.from({ length: 20 }, () => ({ id: uid("p"), userId: me.id, bottleId: kentucky.id, createdAt: t, rating: 4.5 })),
    ]);
    const [p] = await db.select().from(schema.pours).where(eq(schema.pours.bottleId, islayNew.id));
    await db.insert(schema.tastingNotes).values({ id: uid("n"), pourId: p.id, extractedBy: "user", flavorTags: { peat: 2, brine: 1 } });

    const w = await getWrapped(db, me.id, 2026);
    expect(w.discovered.countries).toEqual(["United States"]); // Scotland was met in 2025
    expect(w.discovered.regions).toEqual(["Kentucky"]);
    expect(w.descriptors).toEqual(["Brine / seaweed", "Earthy peat"]);
    expect(w.bestNewFind).toMatchObject({ name: "Kentucky", rating: 4.5 });
    // No field anywhere counts pours: twenty pours of Kentucky are one discovery.
    // A bottle shelved long ago but bought this year counts as met this year.
    const bought = await createTestBottle(db, { name: "Bought", country: "Japan" });
    await db.insert(schema.userBottles).values({ id: uid("ub"), userId: me.id, bottleId: bought.id, relationship: "own", createdAt: old, purchaseDate: t });
    expect((await getWrapped(db, me.id, 2026)).discovered.countries).toEqual(["Japan", "United States"]);
    expect(JSON.stringify(w)).not.toMatch(/"(pours|pourCount|ml|amount|nights|spend|price)"/i);
  });
});

describe("share cards", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-for-cards-0123456789");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("signs per kind/subject/extra and rejects tampering", () => {
    const sig = signCard("wrapped", "u1", "2025")!;
    expect(verifyCard("wrapped", "u1", "2025", sig)).toBe(true);
    expect(verifyCard("wrapped", "u2", "2025", sig)).toBe(false);
    expect(verifyCard("wrapped", "u1", "2024", sig)).toBe(false);
    expect(verifyCard("passport", "u1", "2025", sig)).toBe(false);
    expect(verifyCard("wrapped", "u1", "2025", null)).toBe(false);
    expect(cardPath("passport", "u1", "", "story")).toMatch(/^\/api\/cards\/passport\?s=u1&f=story&sig=/);
  });

  it("mints only your own cards, and the image route 404s on a bad signature", async () => {
    const me = await createTestUser(db);
    await createProfile(db, me, "me_card");
    setSessionUser(me);
    const res = await MINT(jsonRequest("/api/cards", "POST", { kind: "passport" }));
    const { story, link } = (await res.json()) as { story: string; link: string };
    expect(story).toContain(`s=${me.id}`);
    expect(link).toContain("f=link");
    expect((await MINT(jsonRequest("/api/cards", "POST", { kind: "flight", code: "nosuchcode" }))).status).toBe(404);
    expect((await MINT(jsonRequest("/api/cards", "POST", { kind: "wrapped", year: 2099 }))).status).toBe(404);
    expect((await MINT(jsonRequest("/api/cards", "POST", { kind: "passport", userId: "someone" }))).status).toBe(400);

    const forged = story.replace(/sig=[^&]+/, "sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const bad = await CARD(new Request(`http://localhost${forged}`), { params: Promise.resolve({ kind: "passport" }) });
    expect(bad.status).toBe(404);
    const good = await CARD(new Request(`http://localhost${link}`), { params: Promise.resolve({ kind: "passport" }) });
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toContain("image/png");
  });
});
