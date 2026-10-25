import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb, uid } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { blockUser, createProfile } from "@/lib/social";
import {
  clubExportCsv,
  clubShelf,
  createClub,
  createInvite,
  getClubView,
  joinByCode,
  removeMember,
  revokeInvite,
  setRole,
  sweepClubs,
} from "@/lib/clubs";
import {
  claimGuestSeat,
  createFlight,
  findTaster,
  flightIcs,
  flightResultsCsv,
  getFlightView,
  hideEntry,
  joinAsGuest,
  joinAsUser,
  saveEntry,
  setFlightState,
  listMyFlights,
  sweepGuests,
  visibleFlightByCode,
} from "@/lib/flights";
import { listInbox } from "@/lib/notify";
import { POST as JOIN } from "@/app/api/flights/join/route";
import { PUT as ENTRY } from "@/app/api/flights/[code]/entries/route";
import { POST as STATE } from "@/app/api/flights/[code]/state/route";
import { POST as CREATE_FLIGHT } from "@/app/api/flights/route";
import { GET as CLUB_EXPORT } from "@/app/api/clubs/[id]/export/route";

async function person(db: DB, handle: string) {
  const user = await createTestUser(db, { name: handle });
  await createProfile(db, user, handle);
  return user;
}

describe("clubs", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("is invite-only: a non-member sees nothing, an invite joins, a revoked one does not", async () => {
    const owner = await person(db, "owner_c");
    const friend = await person(db, "friend_c");
    const late = await person(db, "late_c");
    const club = await createClub(db, owner.id, { name: "Tuesday Drams" });

    expect(await getClubView(db, friend.id, club.id)).toBeNull();
    expect(await createInvite(db, friend.id, club.id)).toBeNull(); // not a member

    const invite = (await createInvite(db, owner.id, club.id))!;
    expect(await joinByCode(db, friend.id, invite.code)).toEqual({ clubId: club.id });
    expect((await getClubView(db, friend.id, club.id))?.members.map((m) => m.handle).sort()).toEqual(["friend_c", "owner_c"]);
    // The owner hears about it.
    expect((await listInbox(db, owner.id)).map((n) => n.text)).toContain("@friend_c joined Tuesday Drams");

    await revokeInvite(db, owner.id, invite.code);
    expect(await joinByCode(db, late.id, invite.code)).toEqual({ error: "invalid" });
    expect(await joinByCode(db, late.id, "nope")).toEqual({ error: "invalid" });
  });

  it("needs a social profile to start or join", async () => {
    const owner = await person(db, "owner_p");
    const noProfile = await createTestUser(db);
    await expect(createClub(db, noProfile.id, { name: "Nope" })).rejects.toThrow("profile_required");
    const club = await createClub(db, owner.id, { name: "Club" });
    const invite = (await createInvite(db, owner.id, club.id))!;
    expect(await joinByCode(db, noProfile.id, invite.code)).toEqual({ error: "profile_required" });
  });

  it("hides blocked and suspended members from each other", async () => {
    const owner = await person(db, "owner_b");
    const a = await person(db, "a_b");
    const b = await person(db, "b_b");
    const club = await createClub(db, owner.id, { name: "Club" });
    const invite = (await createInvite(db, owner.id, club.id))!;
    await joinByCode(db, a.id, invite.code);
    await joinByCode(db, b.id, invite.code);
    await blockUser(db, a.id, b.id);
    expect((await getClubView(db, a.id, club.id))!.members.map((m) => m.handle)).not.toContain("b_b");
    expect((await getClubView(db, b.id, club.id))!.members.map((m) => m.handle)).not.toContain("a_b");
    await db.update(schema.userProfiles).set({ suspendedAt: new Date() }).where(eq(schema.userProfiles.userId, a.id));
    expect((await getClubView(db, owner.id, club.id))!.members.map((m) => m.handle)).not.toContain("a_b");
  });

  it("enforces removal rules and hands ownership on when the owner leaves", async () => {
    const owner = await person(db, "owner_r");
    const admin = await person(db, "admin_r");
    const member = await person(db, "member_r");
    const club = await createClub(db, owner.id, { name: "Club" });
    const invite = (await createInvite(db, owner.id, club.id))!;
    await joinByCode(db, admin.id, invite.code);
    await joinByCode(db, member.id, invite.code);
    expect(await setRole(db, member.id, club.id, admin.id, "admin")).toBe(false);
    expect(await setRole(db, owner.id, club.id, admin.id, "admin")).toBe(true);

    expect(await removeMember(db, member.id, club.id, admin.id)).toBe(false);
    expect(await removeMember(db, admin.id, club.id, owner.id)).toBe(false);

    expect(await removeMember(db, owner.id, club.id, owner.id)).toBe(true); // leaves
    const view = (await getClubView(db, admin.id, club.id))!;
    expect(view.viewerRole).toBe("owner");
    expect(await removeMember(db, admin.id, club.id, member.id)).toBe(true);

    // Last one out: the club goes.
    await removeMember(db, admin.id, club.id, admin.id);
    expect(await db.query.clubs.findFirst({ where: eq(schema.clubs.id, club.id) })).toBeUndefined();
  });

  it("repairs an ownerless club in the nightly sweep (owner deleted their account)", async () => {
    const owner = await person(db, "owner_s");
    const member = await person(db, "member_s");
    const club = await createClub(db, owner.id, { name: "Club" });
    const invite = (await createInvite(db, owner.id, club.id))!;
    await joinByCode(db, member.id, invite.code);
    await db.delete(schema.user).where(eq(schema.user.id, owner.id));
    await sweepClubs(db);
    expect((await getClubView(db, member.id, club.id))!.viewerRole).toBe("owner");
  });

  it("the club shelf counts distinct bottles from revealed nights and shared notes — never private or friends-only", async () => {
    const owner = await person(db, "owner_sh");
    const club = await createClub(db, owner.id, { name: "Club" });
    const pub = await createTestBottle(db, { name: "Shared", country: "Scotland", region: "Islay" });
    const priv = await createTestBottle(db, { name: "Private" });
    const fr = await createTestBottle(db, { name: "FriendsOnly" });
    const night = await createTestBottle(db, { name: "Night", country: "Japan" });
    await db.insert(schema.pours).values([
      { id: uid("p"), userId: owner.id, bottleId: pub.id, visibility: "public", rating: 4 },
      { id: uid("p"), userId: owner.id, bottleId: pub.id, visibility: "followers", rating: 4 },
      { id: uid("p"), userId: owner.id, bottleId: priv.id, visibility: "private", rating: 4 },
      { id: uid("p"), userId: owner.id, bottleId: fr.id, visibility: "friends", rating: 4 },
    ]);
    const b2 = await createTestBottle(db);
    const b3 = await createTestBottle(db);
    const flight = (await createFlight(db, owner.id, { title: "Night", blind: true, clubId: club.id, bottleIds: [night.id, b2.id, b3.id] }))!;
    expect((await clubShelf(db, owner.id, club.id)).map((b) => b.name)).toEqual(["Shared"]);
    await setFlightState(db, owner.id, flight.id, "revealed");
    const view = (await getClubView(db, owner.id, club.id))!;
    expect(view.shelf.map((b) => b.name)).toContain("Night");
    expect(view.shelf.map((b) => b.name)).not.toContain("Private");
    expect(view.shelf.map((b) => b.name)).not.toContain("FriendsOnly");
    expect(view.passport.countries).toBe(2);
    const csv = (await clubExportCsv(db, owner.id, club.id))!;
    expect(csv).toContain("@owner_sh");
    expect(csv).not.toMatch(/price|ml/i);
  });
});

describe("tasting nights", () => {
  let db: DB;
  let host: schema.User;
  let bottles: schema.Bottle[];
  beforeEach(async () => {
    db = await setupTestDb();
    host = await person(db, "host_f");
    bottles = [
      await createTestBottle(db, { name: "Alpha" }),
      await createTestBottle(db, { name: "Bravo" }),
      await createTestBottle(db, { name: "Charlie" }),
    ];
  });
  const ids = () => bottles.map((b) => b.id);

  it("hides bottles and every rating until the host reveals, then shows the table only", async () => {
    const flight = (await createFlight(db, host.id, { title: "Blind", blind: true, bottleIds: ids() }))!;
    const taster = await person(db, "taster_f");
    const bystander = await person(db, "bystander_f");
    await joinAsUser(db, flight.id, taster.id);
    const seat = (await findTaster(db, flight.id, { userId: taster.id }))!;
    await saveEntry(db, flight.id, seat, { slot: "A", rating: 4, flavorTags: { vanilla: 2 }, note: "soft" });

    const before = await getFlightView(db, flight, taster.id, seat);
    expect(before.slots.every((s) => s.bottle === null && s.results === null)).toBe(true);
    expect(before.slots[0].mine).toMatchObject({ rating: 4 });
    const hostBefore = await getFlightView(db, flight, host.id, await findTaster(db, flight.id, { userId: host.id }));
    expect(hostBefore.slots[0].bottle?.name).toBe("Alpha"); // the host poured it
    expect(hostBefore.slots[0].results).toBeNull(); // …but sees no ratings early

    expect(await setFlightState(db, taster.id, flight.id, "revealed")).toBeNull(); // not the host
    await setFlightState(db, host.id, flight.id, "revealed");
    const reloaded = (await db.query.flights.findFirst({ where: eq(schema.flights.id, flight.id) }))!;
    const after = await getFlightView(db, reloaded, taster.id, seat);
    expect(after.slots[0].bottle?.name).toBe("Alpha");
    expect(after.slots[0].results).toMatchObject({ average: 4, ratings: 1 });
    expect(after.slots[0].results!.entries[0]).toMatchObject({ mine: true, tags: ["Vanilla"], note: "soft" });
    // Ratings are frozen after the reveal.
    expect(await saveEntry(db, flight.id, seat, { slot: "A", rating: 5 })).toBeNull();
    // A bystander with the link sees the bottles but not the table's notes.
    const outsider = await getFlightView(db, reloaded, bystander.id, null);
    expect(outsider.slots[0].results).toBeNull();
    expect((await listInbox(db, taster.id)).map((n) => n.text)).toContain("The bottles in Blind are revealed");
    expect(flightResultsCsv(after)).toContain("Alpha");
  });

  it("lets a 21+ guest rate for 24 hours without an account, refuses the underage, and sweeps them", async () => {
    const flight = (await createFlight(db, host.id, { title: "Night", blind: false, bottleIds: ids() }))!;
    const now = new Date("2026-10-20T20:00:00Z");
    expect(await joinAsGuest(db, flight.id, { guestName: "Kid", birthDate: "2006-01-01", market: "US" }, now)).toEqual({ error: "underage" });
    const joined = await joinAsGuest(db, flight.id, { guestName: "Pat", birthDate: "1990-05-05", market: "US" }, now);
    expect("token" in joined && joined.token).toBeTruthy();
    const token = (joined as { token: string }).token;
    const seat = (await findTaster(db, flight.id, { guestToken: token }, now))!;
    expect(seat.guest).toBe(true);
    await saveEntry(db, flight.id, seat, { slot: "B", rating: 3 });
    // The raw token is never stored.
    const rows = await db.select().from(schema.flightParticipants).where(eq(schema.flightParticipants.flightId, flight.id));
    expect(rows.some((r) => r.guestTokenHash === token)).toBe(false);
    // Expired after 24 h, and swept.
    expect(await findTaster(db, flight.id, { guestToken: token }, new Date(now.getTime() + 25 * 3600_000))).toBeNull();
    await sweepGuests(db, new Date(now.getTime() + 25 * 3600_000));
    expect(await db.select().from(schema.flightEntries).where(eq(schema.flightEntries.flightId, flight.id))).toEqual([]);
  });

  it("a guest who signs up keeps their ratings", async () => {
    const flight = (await createFlight(db, host.id, { title: "Night", blind: true, bottleIds: ids() }))!;
    const joined = (await joinAsGuest(db, flight.id, { guestName: "Pat", birthDate: "1990-05-05", market: "US" })) as { token: string };
    const seat = (await findTaster(db, flight.id, { guestToken: joined.token }))!;
    await saveEntry(db, flight.id, seat, { slot: "C", rating: 5 });
    const pat = await person(db, "pat_f");
    expect(await claimGuestSeat(db, flight.id, joined.token, pat.id)).toBe(true);
    const mine = (await findTaster(db, flight.id, { userId: pat.id }))!;
    expect((await getFlightView(db, flight, pat.id, mine)).slots[2].mine).toMatchObject({ rating: 5 });
    expect(await findTaster(db, flight.id, { guestToken: joined.token })).toBeNull();
  });

  it("hides a blocked taster's notes and a host-hidden note from the table", async () => {
    const flight = (await createFlight(db, host.id, { title: "Night", blind: false, bottleIds: ids() }))!;
    const a = await person(db, "a_f");
    const b = await person(db, "b_f");
    for (const u of [a, b]) await joinAsUser(db, flight.id, u.id);
    const seatA = (await findTaster(db, flight.id, { userId: a.id }))!;
    const seatB = (await findTaster(db, flight.id, { userId: b.id }))!;
    await saveEntry(db, flight.id, seatA, { slot: "A", rating: 4 });
    const eb = (await saveEntry(db, flight.id, seatB, { slot: "A", rating: 2, note: "rude" }))!;
    await setFlightState(db, host.id, flight.id, "revealed");
    await blockUser(db, a.id, b.id);
    const fresh = (await db.query.flights.findFirst({ where: eq(schema.flights.id, flight.id) }))!;
    expect((await getFlightView(db, fresh, a.id, seatA)).slots[0].results!.entries.map((e) => e.handle)).toEqual(["a_f"]);
    expect(await hideEntry(db, a.id, eb.id)).toBe(false);
    expect(await hideEntry(db, host.id, eb.id)).toBe(true);
    const hostSeat = await findTaster(db, flight.id, { userId: host.id });
    expect((await getFlightView(db, fresh, host.id, hostSeat)).slots[0].results!.entries.map((e) => e.handle)).toEqual(["a_f"]);
  });

  it("refuses a club night from a non-member and invites the club otherwise", async () => {
    const outsider = await person(db, "out_f");
    const club = await createClub(db, host.id, { name: "Club" });
    await expect(createFlight(db, outsider.id, { title: "x", blind: true, clubId: club.id, bottleIds: ids() })).rejects.toThrow();
    const member = await person(db, "member_f");
    await joinByCode(db, member.id, (await createInvite(db, host.id, club.id))!.code);
    await createFlight(db, host.id, { title: "Club night", blind: true, clubId: club.id, bottleIds: ids() });
    expect((await listInbox(db, member.id)).map((n) => n.text)).toContain("@host_f invited you to Club night");
  });

  it("a block or a suspended host closes the flight to that viewer; pending bottles can't be poured", async () => {
    const flight = (await createFlight(db, host.id, { title: "Night", blind: true, bottleIds: ids() }))!;
    const t = await person(db, "t_vis");
    expect(await visibleFlightByCode(db, flight.joinCode, t.id)).not.toBeNull();
    await joinAsUser(db, flight.id, t.id);
    expect((await listMyFlights(db, t.id)).map((f) => f.joinCode)).toEqual([flight.joinCode]);
    await blockUser(db, host.id, t.id);
    expect(await visibleFlightByCode(db, flight.joinCode, t.id)).toBeNull();
    expect(await listMyFlights(db, t.id)).toEqual([]);
    expect(await visibleFlightByCode(db, flight.joinCode, host.id)).not.toBeNull();
    await db.update(schema.userProfiles).set({ suspendedAt: new Date() }).where(eq(schema.userProfiles.userId, host.id));
    expect(await visibleFlightByCode(db, flight.joinCode, null)).toBeNull();
    // Lists drop it too.
    expect((await listMyFlights(db, host.id)).map((f) => f.joinCode)).toContain(flight.joinCode);
    await joinAsUser(db, flight.id, (await person(db, "seat_vis")).id);
    const noProfile = await createTestUser(db);
    await expect(createFlight(db, noProfile.id, { title: "x", blind: true, bottleIds: ids() })).rejects.toThrow("profile_required");
    await db.update(schema.userProfiles).set({ suspendedAt: null }).where(eq(schema.userProfiles.userId, host.id));
    const pending = await createTestBottle(db, { status: "user_submitted" });
    expect(await createFlight(db, host.id, { title: "x", blind: true, bottleIds: [...ids().slice(0, 2), pending.id] })).toBeNull();
  });

  it("writes an .ics only for a scheduled night", () => {
    const base = { id: "f1", title: "Islay, night", joinCode: "abcdefgh", scheduledAt: null };
    expect(flightIcs(base, "https://x")).toBeNull();
    const ics = flightIcs({ ...base, scheduledAt: new Date("2026-11-01T19:00:00Z") }, "https://x")!;
    expect(ics).toContain("DTSTART:20261101T190000Z");
    expect(ics).toContain("SUMMARY:Islay\\, night");
    expect(ics).toContain("URL:https://x/f/abcdefgh");
  });
});

describe("flight and club routes", () => {
  let db: DB;
  let host: schema.User;
  beforeEach(async () => {
    db = await setupTestDb();
    host = await person(db, "host_r");
  });

  it("guest join sets an httpOnly cookie that the entries route honours; no seat is a 403", async () => {
    const bs = [await createTestBottle(db), await createTestBottle(db), await createTestBottle(db)];
    const flight = (await createFlight(db, host.id, { title: "Night", blind: true, bottleIds: bs.map((b) => b.id) }))!;
    setSessionUser(null);
    expect((await JOIN(jsonRequest("/api/flights/join", "POST", { code: flight.joinCode }))).status).toBe(401);
    const young = await JOIN(jsonRequest("/api/flights/join", "POST", { code: flight.joinCode, guest: { guestName: "K", birthDate: "2010-01-01", market: "US" } }));
    expect(young.status).toBe(403);
    const res = await JOIN(jsonRequest("/api/flights/join", "POST", { code: flight.joinCode, guest: { guestName: "Pat", birthDate: "1990-01-01", market: "US" } }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    const pair = cookie.split(";")[0];

    const ctx = { params: Promise.resolve({ code: flight.joinCode }) };
    const noSeat = await ENTRY(jsonRequest(`/api/flights/${flight.joinCode}/entries`, "PUT", { slot: "A", rating: 4 }), ctx);
    expect(noSeat.status).toBe(403);
    const req = new Request(`http://localhost:3000/api/flights/${flight.joinCode}/entries`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: pair },
      body: JSON.stringify({ slot: "A", rating: 4, flavorTags: { "not-a-tag": 1 } }),
    });
    expect((await ENTRY(req, ctx)).status).toBe(400);
    const ok = new Request(`http://localhost:3000/api/flights/${flight.joinCode}/entries`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: pair },
      body: JSON.stringify({ slot: "A", rating: 4, flavorTags: { vanilla: 2 } }),
    });
    expect((await ENTRY(ok, ctx)).status).toBe(200);

    setSessionUser(await person(db, "notthehost"));
    expect((await STATE(jsonRequest("/", "POST", { to: "revealed" }), ctx)).status).toBe(404);
    setSessionUser(host);
    expect((await STATE(jsonRequest("/", "POST", { to: "revealed" }), ctx)).status).toBe(200);
  });

  it("create validates 3–6 distinct bottles; club export is members-only", async () => {
    setSessionUser(host);
    const b = await createTestBottle(db);
    expect((await CREATE_FLIGHT(jsonRequest("/api/flights", "POST", { title: "x", bottleIds: [b.id, b.id, b.id] }))).status).toBe(400);
    expect((await CREATE_FLIGHT(jsonRequest("/api/flights", "POST", { title: "Night", bottleIds: ["a", "b", "c"] }))).status).toBe(404);
    const club = await createClub(db, host.id, { name: "Club" });
    const ctx = { params: Promise.resolve({ id: club.id }) };
    expect((await CLUB_EXPORT(new Request("http://localhost/x"), ctx)).status).toBe(200);
    setSessionUser(await person(db, "stranger_r"));
    expect((await CLUB_EXPORT(new Request("http://localhost/x"), ctx)).status).toBe(404);
  });
});
