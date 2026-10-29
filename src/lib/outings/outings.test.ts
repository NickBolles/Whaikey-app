import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb, uid } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { blockUser, createProfile } from "@/lib/social";
import { createClub } from "@/lib/clubs";
import {
  OUTING_ITEM_CAP,
  addOutingNote,
  addTasting,
  buildRecap,
  claimOutingGuestSeat,
  createOuting,
  deleteOuting,
  deleteOwnItem,
  endOuting,
  findOutingSeat,
  getOutingView,
  hideOutingItem,
  inviteFriends,
  joinOutingAsGuest,
  joinOutingAsUser,
  listInvitableFriends,
  listMyOutings,
  nextOutingFor,
  outingCsv,
  sweepOutingGuests,
  updateTasting,
  visibleOutingByCode,
} from "@/lib/outings";
import { listInbox } from "@/lib/notify";
import { POST as CREATE } from "@/app/api/outings/route";
import { POST as JOIN } from "@/app/api/outings/join/route";
import { POST as TASTE } from "@/app/api/outings/[code]/tastings/route";
import { DELETE as UNTASTE, PATCH as RETASTE } from "@/app/api/outings/[code]/tastings/[id]/route";
import { POST as NOTE } from "@/app/api/outings/[code]/notes/route";
import { GET as POLL, POST as STATE } from "@/app/api/outings/[code]/state/route";
import { POST as HIDE } from "@/app/api/outings/[code]/hide/route";
import { GET as INVITABLE, POST as INVITE } from "@/app/api/outings/[code]/invite/route";
import { POST as CLAIM } from "@/app/api/outings/[code]/claim/route";
import { GET as EXPORT } from "@/app/api/outings/[code]/export/route";
import { DELETE as DELETE_OUTING } from "@/app/api/outings/[code]/route";
import { POST as MINT_CARD } from "@/app/api/cards/route";
import { GET as CARD } from "@/app/api/cards/[kind]/route";

async function person(db: DB, handle: string) {
  const user = await createTestUser(db, { name: handle });
  await createProfile(db, user, handle);
  return user;
}

async function befriend(db: DB, a: string, b: string) {
  await db.insert(schema.follows).values([
    { id: uid("f"), followerId: a, followeeId: b, state: "accepted" },
    { id: uid("f"), followerId: b, followeeId: a, state: "accepted" },
  ]);
}

const input = { title: "Bourbon Trail Saturday", distilleryName: "Buffalo Trace", visitOn: "2026-10-31", rideReminder: true };
const adult = { guestName: "Pat", birthDate: "1990-01-01", market: "US" };
const p = (code: string, id?: string) => ({ params: Promise.resolve(id ? { code, id } : { code }) }) as never;

function withCookie(url: string, method: string, cookie: string, body?: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("outings (D22)", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
    setSessionUser(null);
  });

  it("a host plans one, friends and guests join, everyone logs, the recap has no counts", async () => {
    const host = await person(db, "host_o");
    const friend = await person(db, "friend_o");
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10" });
    const outing = await createOuting(db, host.id, input);
    expect(outing.state).toBe("open");
    expect(await findOutingSeat(db, outing.id, { userId: host.id })).not.toBeNull();

    expect(await joinOutingAsUser(db, outing.id, friend.id)).toMatchObject({ participantId: expect.any(String) });
    const guest = await joinOutingAsGuest(db, outing.id, adult);
    expect(guest).toMatchObject({ token: expect.any(String) });
    expect(await joinOutingAsGuest(db, outing.id, { ...adult, birthDate: "2012-01-01" })).toEqual({ error: "underage" });

    const hostSeat = (await findOutingSeat(db, outing.id, { userId: host.id }))!;
    const friendSeat = (await findOutingSeat(db, outing.id, { userId: friend.id }))!;
    const guestSeat = (await findOutingSeat(db, outing.id, { guestToken: guest.token }))!;
    expect(guestSeat.guest).toBe(true);

    expect(await addTasting(db, outing, hostSeat, { bottleId: bottle.id, rating: 4, flavorTags: { vanilla: 2 } })).toMatchObject({ id: expect.any(String) });
    expect(await addTasting(db, outing, friendSeat, { bottleId: bottle.id, rating: 5, flavorTags: { vanilla: 1, oak: 2 } })).toMatchObject({ id: expect.any(String) });
    // A distillery-only cask sample: no catalog row, just a name.
    expect(await addTasting(db, outing, guestSeat, { label: "Cask 1142 sample", rating: 3, flavorTags: { cherry: 2 } })).toMatchObject({ id: expect.any(String) });
    expect(await addTasting(db, outing, guestSeat, { bottleId: "nope" })).toEqual({ error: "bottle_not_found" });
    await addOutingNote(db, outing, friendSeat, "The warehouse tour was the highlight.");

    const view = await getOutingView(db, outing, friend.id, friendSeat);
    expect(view.people.map((x) => x.name).sort()).toEqual(["@friend_o", "@host_o", "Pat"]);
    expect(view.feed).toHaveLength(4);
    expect(view.feed.find((f) => f.label === "Cask 1142 sample")?.who).toBe("Pat");

    await endOuting(db, host.id, outing.id);
    const ended = (await visibleOutingByCode(db, outing.joinCode, friend.id))!;
    expect(await addTasting(db, ended, friendSeat, { label: "Too late" })).toEqual({ error: "not_open" });
    const recap = (await getOutingView(db, ended, friend.id, friendSeat)).recap!;
    expect(recap.bottles.map((b) => b.label)).toEqual(["Cask 1142 sample", "Eagle Rare 10"]);
    expect(recap.favorite).toMatchObject({ label: "Eagle Rare 10", average: 4.5, consensus: true, sharedTags: ["Vanilla"] });
    expect(recap.spread.reduce((a, s) => a + s.share, 0)).toBeGreaterThanOrEqual(99);
    // The recap's shape carries no per-person tallies or amounts.
    expect(JSON.stringify(recap)).not.toMatch(/count|ml|amount|pours/i);
    // Everyone seated with an account hears the recap is ready (not the host).
    expect((await listInbox(db, friend.id)).map((n) => n.text)).toContain("The recap for Bourbon Trail Saturday is ready");
    expect(outingCsv(await getOutingView(db, ended, friend.id, friendSeat))).toContain("Cask 1142 sample");
    const many = await createOuting(db, host.id, input);
    const manySeat = (await findOutingSeat(db, many.id, { userId: host.id }))!;
    await addTasting(db, many, manySeat, { label: "Busy dram", flavorTags: { vanilla: 3, oak: 2, cherry: 2, honey: 1, "dark-fruit": 1 } });
    const csv = outingCsv(await getOutingView(db, many, host.id, manySeat));
    for (const d of ["Vanilla", "Oak", "Cherry", "Honey", "Dark fruit"]) expect(csv).toContain(d);
  });

  it("nextOutingFor is the soonest open outing from today, never an ended or past one", async () => {
    const host = await person(db, "host_next");
    const later = await createOuting(db, host.id, { ...input, title: "Later", visitOn: "2026-11-20" });
    const soon = await createOuting(db, host.id, { ...input, title: "Soon", visitOn: "2026-10-29" });
    await createOuting(db, host.id, { ...input, title: "Past", visitOn: "2026-10-01" });
    expect((await nextOutingFor(db, host.id, "2026-10-27"))?.joinCode).toBe(soon.joinCode);
    await endOuting(db, host.id, soon.id);
    expect((await nextOutingFor(db, host.id, "2026-10-27"))?.joinCode).toBe(later.joinCode);
    expect(await nextOutingFor(db, host.id, "2026-12-01")).toBeNull();
    await db.update(schema.userProfiles).set({ suspendedAt: new Date() }).where(eq(schema.userProfiles.userId, host.id));
    expect(await nextOutingFor(db, host.id, "2026-10-27")).toBeNull();
  });

  it("one voice per person per bottle: a second taste never weighs the consensus", () => {
    const r = buildRecap([
      { label: "A", bottleId: "a", rating: 5, flavorTags: null, participantId: "p1" },
      { label: "A", bottleId: "a", rating: 5, flavorTags: null, participantId: "p1" },
      { label: "A", bottleId: "a", rating: 3, flavorTags: null, participantId: "p2" },
      { label: "B", bottleId: null, rating: 5, flavorTags: null, participantId: "p1" },
      { label: " b ", bottleId: null, rating: 4, flavorTags: null, participantId: "p2" },
    ]);
    expect(r.bottles).toHaveLength(2);
    expect(r.bottles.find((b) => b.label === "A")?.average).toBe(4);
    expect(r.favorite).toMatchObject({ label: "B", average: 4.5, consensus: true });
    // Ranked on the unrounded mean: 4.25 and 4.33 both show as 4.3, but B wins.
    const close = buildRecap([
      ...[4, 4, 4, 5].map((rating, i) => ({ label: "A", bottleId: "a", rating, flavorTags: null, participantId: `a${i}` })),
      ...[4, 4, 5].map((rating, i) => ({ label: "B", bottleId: "b", rating, flavorTags: null, participantId: `b${i}` })),
    ]);
    expect(close.favorite).toMatchObject({ label: "B", average: 4.3 });
    expect(buildRecap([]).favorite).toBeNull();
    expect(buildRecap([{ label: "Solo", bottleId: null, rating: 4, flavorTags: null, participantId: "p1" }]).favorite).toMatchObject({ consensus: false });
  });

  it("needs a profile to host, a club membership to tag a club, and matches a catalog distillery", async () => {
    const noProfile = await createTestUser(db);
    await expect(createOuting(db, noProfile.id, input)).rejects.toThrow("profile_required");
    const host = await person(db, "host_c");
    const club = await createClub(db, (await person(db, "clubowner")).id, { name: "Not yours" });
    await expect(createOuting(db, host.id, { ...input, clubId: club.id })).rejects.toThrow("not_a_member");
    await db.insert(schema.distilleries).values({ id: "bt", name: "Buffalo Trace", country: "USA" });
    expect((await createOuting(db, host.id, { ...input, distilleryName: "buffalo trace" })).distilleryId).toBe("bt");
  });

  it("club members get an invite; the host can invite mutual friends, nobody else", async () => {
    const host = await person(db, "host_i");
    const member = await person(db, "member_i");
    const friend = await person(db, "friend_i");
    const stranger = await person(db, "stranger_i");
    const club = await createClub(db, host.id, { name: "Tuesday Drams" });
    await db.insert(schema.clubMembers).values({ clubId: club.id, userId: member.id, role: "member" });
    const outing = await createOuting(db, host.id, { ...input, clubId: club.id });
    expect((await listInbox(db, member.id)).map((n) => n.text)).toContain("@host_i invited you to Bourbon Trail Saturday");

    await befriend(db, host.id, friend.id);
    expect((await listInvitableFriends(db, host.id, outing.id)).map((f) => f.handle)).toEqual(["friend_i"]);
    expect(await inviteFriends(db, host.id, outing, [friend.id, stranger.id])).toBe(1);
    expect(await inviteFriends(db, friend.id, outing, [host.id])).toBe(0); // not the host
    expect(await listInbox(db, stranger.id)).toHaveLength(0);
    await joinOutingAsUser(db, outing.id, friend.id);
    expect(await listInvitableFriends(db, host.id, outing.id)).toEqual([]);
  });

  it("respects blocks, suspension and the host's hide", async () => {
    const host = await person(db, "host_b");
    const blocked = await person(db, "blocked_b");
    const friend = await person(db, "friend_b");
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, friend.id);
    await blockUser(db, host.id, blocked.id);
    expect(await visibleOutingByCode(db, outing.joinCode, blocked.id)).toBeNull();
    expect(await joinOutingAsUser(db, outing.id, blocked.id)).toEqual({ error: "blocked" });

    // A friend blocked by another attendee vanishes from that attendee's feed.
    const other = await person(db, "other_b");
    await joinOutingAsUser(db, outing.id, other.id);
    const friendSeat = (await findOutingSeat(db, outing.id, { userId: friend.id }))!;
    const otherSeat = (await findOutingSeat(db, outing.id, { userId: other.id }))!;
    const t = (await addTasting(db, outing, friendSeat, { label: "Sample", rating: 4 })) as { id: string };
    await blockUser(db, other.id, friend.id);
    const otherView = await getOutingView(db, outing, other.id, otherSeat);
    expect(otherView.feed).toHaveLength(0);
    expect(otherView.people.map((x) => x.name)).not.toContain("@friend_b");

    // Suspension hides the account's rows from everyone else.
    await db.update(schema.userProfiles).set({ suspendedAt: new Date() }).where(eq(schema.userProfiles.userId, friend.id));
    // … and a suspended viewer reads nobody's outing, nor lists any.
    expect(await visibleOutingByCode(db, outing.joinCode, friend.id)).toBeNull();
    expect(await listMyOutings(db, friend.id)).toEqual([]);
    const hostView = await getOutingView(db, outing, host.id, await findOutingSeat(db, outing.id, { userId: host.id }));
    expect(hostView.feed).toHaveLength(0);
    await db.update(schema.userProfiles).set({ suspendedAt: null }).where(eq(schema.userProfiles.userId, friend.id));

    expect(await hideOutingItem(db, friend.id, outing, "tasting", t.id)).toBe(false);
    expect(await hideOutingItem(db, host.id, outing, "tasting", t.id)).toBe(true);
    expect((await getOutingView(db, outing, host.id, null)).feed).toHaveLength(0);

    // A host who steps back takes the outing off everyone's screen.
    await db.update(schema.userProfiles).set({ socialEnabled: false }).where(eq(schema.userProfiles.userId, host.id));
    expect(await visibleOutingByCode(db, outing.joinCode, friend.id)).toBeNull();
    expect(await listMyOutings(db, friend.id)).toEqual([]);
  });

  it("a bystander holding the link sees the join screen only, and a pending bottle stays its submitter's", async () => {
    const host = await person(db, "host_v");
    const friend = await person(db, "friend_v");
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, friend.id);
    const friendSeat = (await findOutingSeat(db, outing.id, { userId: friend.id }))!;
    const pending = await createTestBottle(db, { name: "My own submission" });
    await db.update(schema.bottles).set({ status: "user_submitted", submittedBy: friend.id }).where(eq(schema.bottles.id, pending.id));
    expect(await addTasting(db, outing, friendSeat, { bottleId: pending.id, rating: 4 })).toMatchObject({ id: expect.any(String) });
    const hostSeat = await findOutingSeat(db, outing.id, { userId: host.id });
    // Someone else's pending bottle can't be logged by id …
    expect(await addTasting(db, outing, hostSeat!, { bottleId: pending.id })).toEqual({ error: "bottle_not_found" });
    // … and on the feed it shows by name with no link for anyone but its submitter.
    expect((await getOutingView(db, outing, host.id, hostSeat)).feed[0]).toMatchObject({ label: "My own submission", bottleId: null });
    expect((await getOutingView(db, outing, friend.id, friendSeat)).feed[0].bottleId).toBe(pending.id);

    const bystander = await getOutingView(db, outing, null, null);
    expect(bystander.feed).toEqual([]);
    expect(bystander.recap).toBeNull();
  });

  it("edits, removals and deletion are the owner's only; guests are swept at 24 h and can claim", async () => {
    const host = await person(db, "host_e");
    const friend = await person(db, "friend_e");
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, friend.id);
    const friendSeat = (await findOutingSeat(db, outing.id, { userId: friend.id }))!;
    const hostSeat = (await findOutingSeat(db, outing.id, { userId: host.id }))!;
    const t = (await addTasting(db, outing, friendSeat, { label: "Sample", rating: 3 })) as { id: string };
    expect(await updateTasting(db, outing, hostSeat, t.id, { rating: 5 })).toBe(false);
    expect(await updateTasting(db, outing, friendSeat, t.id, { rating: 4.5, note: "better second time" })).toBe(true);
    expect(await deleteOwnItem(db, outing, hostSeat, "tasting", t.id)).toBe(false);
    expect(await deleteOwnItem(db, outing, friendSeat, "tasting", t.id)).toBe(true);

    const now = new Date("2026-10-31T15:00:00Z");
    const g = await joinOutingAsGuest(db, outing.id, adult, now);
    const gSeat = (await findOutingSeat(db, outing.id, { guestToken: g.token }, now))!;
    await addTasting(db, outing, gSeat, { label: "Guest sample", rating: 4 });
    const later = await person(db, "later_e");
    expect(await claimOutingGuestSeat(db, outing.id, g.token!, later.id, now)).toBe(true);
    expect((await getOutingView(db, outing, later.id, await findOutingSeat(db, outing.id, { userId: later.id }))).feed[0]).toMatchObject({ label: "Guest sample", mine: true });
    // Claiming into an account that already has a seat merges: the guest's bottle additions move too.
    const g3 = await joinOutingAsGuest(db, outing.id, adult, now);
    const g3Seat = (await findOutingSeat(db, outing.id, { guestToken: g3.token }, now))!;
    await addTasting(db, outing, g3Seat, { label: "Guest-only cask", rating: 4 });
    expect(await claimOutingGuestSeat(db, outing.id, g3.token!, friend.id, now)).toBe(true);
    const moved = (await db.select().from(schema.outingBottles)).filter((b) => b.participantId === friendSeat.participantId);
    expect(moved.length).toBeGreaterThan(0);

    const g2 = await joinOutingAsGuest(db, outing.id, adult, now);
    await sweepOutingGuests(db, new Date(now.getTime() + 25 * 3600_000));
    expect(await findOutingSeat(db, outing.id, { guestToken: g2.token }, now)).toBeNull();

    for (let i = 0; i < OUTING_ITEM_CAP; i++) await addTasting(db, outing, hostSeat, { label: `Sample ${i}` });
    expect(await addTasting(db, outing, hostSeat, { label: "One more" })).toEqual({ error: "too_many" });

    expect(await deleteOuting(db, friend.id, outing.id)).toBe(false);
    expect(await deleteOuting(db, host.id, outing.id)).toBe(true);
    expect(await db.select().from(schema.outingTastings)).toEqual([]);
  });
});

describe("outing routes", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
  });

  it("create → guest join via cookie → log → note → poll → end → export → card → delete", async () => {
    const host = await person(db, "host_r");
    setSessionUser(host);
    expect((await CREATE(jsonRequest("/api/outings", "POST", { title: "x" }))).status).toBe(400);
    const created = await CREATE(jsonRequest("/api/outings", "POST", { title: "Trip", distilleryName: "Ardbeg", visitOn: "2026-11-01" }));
    expect(created.status).toBe(201);
    const { joinCode } = (await created.json()) as { joinCode: string };

    setSessionUser(null);
    expect((await JOIN(jsonRequest("/api/outings/join", "POST", { code: joinCode }))).status).toBe(401);
    expect((await JOIN(jsonRequest("/api/outings/join", "POST", { code: joinCode, guest: { ...adult, birthDate: "2012-01-01" } }))).status).toBe(403);
    const joined = await JOIN(jsonRequest("/api/outings/join", "POST", { code: joinCode, guest: adult }));
    expect(joined.status).toBe(200);
    const setCookie = joined.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/i);
    const cookie = setCookie.split(";")[0];

    expect((await TASTE(jsonRequest(`/api/outings/${joinCode}/tastings`, "POST", { label: "No seat" }), p(joinCode))).status).toBe(403);
    expect((await TASTE(withCookie(`/api/outings/${joinCode}/tastings`, "POST", cookie, {}), p(joinCode))).status).toBe(400);
    const logged = await TASTE(withCookie(`/api/outings/${joinCode}/tastings`, "POST", cookie, { label: "Cask sample", rating: 4, flavorTags: { peat: 2 } }), p(joinCode));
    expect(logged.status).toBe(201);
    const { id } = (await logged.json()) as { id: string };
    expect((await RETASTE(withCookie(`/api/outings/${joinCode}/tastings/${id}`, "PATCH", cookie, { rating: 4.5 }), p(joinCode, id))).status).toBe(200);
    expect((await NOTE(withCookie(`/api/outings/${joinCode}/notes`, "POST", cookie, { body: "Great tour" }), p(joinCode))).status).toBe(201);
    const poll1 = (await (await POLL(withCookie(`/api/outings/${joinCode}/state`, "GET", cookie), p(joinCode))).json()) as { stamp: string };

    setSessionUser(host);
    expect((await HIDE(jsonRequest("/", "POST", { kind: "note", id: "nope" }), p(joinCode))).status).toBe(404);
    expect((await (await INVITABLE(jsonRequest("/", "GET"), p(joinCode))).json())).toEqual({ items: [] });
    expect((await (await INVITE(jsonRequest("/", "POST", { userIds: ["x"] }), p(joinCode))).json())).toEqual({ sent: 0 });
    expect((await STATE(jsonRequest("/", "POST", { to: "ended" }), p(joinCode))).status).toBe(200);
    expect((await STATE(jsonRequest("/", "POST", { to: "ended" }), p(joinCode))).status).toBe(409);
    const exported = await EXPORT(jsonRequest(`/api/outings/${joinCode}/export`, "GET"), p(joinCode));
    expect(exported.headers.get("content-type")).toMatch(/text\/csv/);
    expect(await exported.text()).toContain("Cask sample");

    setSessionUser(null);
    const poll2 = (await (await POLL(withCookie(`/api/outings/${joinCode}/state`, "GET", cookie), p(joinCode))).json()) as { stamp: string; state: string };
    expect(poll2.state).toBe("ended");
    expect(poll2.stamp).not.toBe(poll1.stamp);
    expect((await UNTASTE(withCookie(`/api/outings/${joinCode}/tastings/${id}`, "DELETE", cookie), p(joinCode, id))).status).toBe(200);

    // Signing in to an account that hasn't passed the age gate doesn't keep the guest seat working.
    const ungated = await createTestUser(db, { ageVerified: false });
    setSessionUser(ungated);
    expect((await TASTE(withCookie(`/api/outings/${joinCode}/tastings`, "POST", cookie, { label: "x1" }), p(joinCode))).status).toBe(403);

    // A guest who signs up keeps their seat.
    const later = await person(db, "later_r");
    setSessionUser(later);
    expect((await CLAIM(withCookie(`/api/outings/${joinCode}/claim`, "POST", cookie, {}), p(joinCode))).status).toBe(200);

    setSessionUser(host);
    const card = await MINT_CARD(jsonRequest("/api/cards", "POST", { kind: "outing", code: joinCode }));
    expect([200, 503]).toContain(card.status);
    setSessionUser(later);
    expect((await DELETE_OUTING(jsonRequest("/", "DELETE"), p(joinCode))).status).toBe(404);
    setSessionUser(host);
    expect((await DELETE_OUTING(jsonRequest("/", "DELETE"), p(joinCode))).status).toBe(200);
  });
});

describe("the outing recap card", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-for-cards-0123456789");
  });

  it("renders for someone on the ended outing, and stops for anyone who loses access", async () => {
    const host = await person(db, "host_k");
    const friend = await person(db, "friend_k");
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, friend.id);
    const seat = (await findOutingSeat(db, outing.id, { userId: friend.id }))!;
    await addTasting(db, outing, seat, { label: "Cask 1142", rating: 4, flavorTags: { vanilla: 2 } });

    setSessionUser(friend);
    // Not while it's open.
    expect((await MINT_CARD(jsonRequest("/api/cards", "POST", { kind: "outing", code: outing.joinCode }))).status).toBe(404);
    await endOuting(db, host.id, outing.id);
    const minted = await MINT_CARD(jsonRequest("/api/cards", "POST", { kind: "outing", code: outing.joinCode }));
    expect(minted.status).toBe(200);
    const { story, link } = (await minted.json()) as { story: string; link: string };
    expect(link).not.toContain(outing.joinCode);
    const render = (path: string) => CARD(new Request(`http://localhost${path}`), { params: Promise.resolve({ kind: "outing" }) });
    const png = await render(link);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect((await render(story)).status).toBe(200);

    // A stranger can't mint one; a block with the host stops the card.
    setSessionUser(await person(db, "stranger_k"));
    expect((await MINT_CARD(jsonRequest("/api/cards", "POST", { kind: "outing", code: outing.joinCode }))).status).toBe(404);
    await blockUser(db, host.id, friend.id);
    expect((await render(link)).status).toBe(404);
  });
});
