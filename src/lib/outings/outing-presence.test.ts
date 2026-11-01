import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { blockUser, createProfile, followByHandle } from "@/lib/social";
import { createOuting, endOuting, findOutingSeat, getOutingView, joinOutingAsUser } from "@/lib/outings";
import { POST as PRESENCE } from "@/app/api/outings/[code]/presence/route";

async function person(db: DB, handle: string) {
  const user = await createTestUser(db, { name: handle });
  await createProfile(db, user, handle);
  return user;
}
const input = { title: "Distillery Sunday", distilleryName: "Buffalo Trace", visitOn: "2026-11-01", rideReminder: true };
const p = (code: string) => ({ params: Promise.resolve({ code }) }) as never;
const beat = (code: string, body?: unknown) =>
  PRESENCE(body === undefined ? new Request(`http://t/api/outings/${code}/presence`, { method: "POST" }) : jsonRequest(`/api/outings/${code}/presence`, "POST", body), p(code));

describe("outing presence + members (route, real database)", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
    setSessionUser(null);
  });

  async function trip() {
    const host = await person(db, "host_p");
    const ana = await person(db, "ana_p");
    const ben = await person(db, "ben_p");
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, ana.id);
    await joinOutingAsUser(db, outing.id, ben.id);
    const seat = async (userId: string) => (await findOutingSeat(db, outing.id, { userId }))!;
    return { host, ana, ben, outing, seat };
  }

  it("a member's heartbeat stores last_seen and others on the trip see them here now", async () => {
    const { host, ana, ben, outing, seat } = await trip();
    setSessionUser(ana);
    const res = await beat(outing.joinCode);
    expect(res.status).toBe(200);
    const anaSeat = await seat(ana.id);
    expect(await res.json()).toEqual({ here: [anaSeat.participantId], show: true });
    const row = await db.query.outingParticipants.findFirst({ where: eq(schema.outingParticipants.id, anaSeat.participantId) });
    expect(row?.lastSeenAt).toBeInstanceOf(Date);

    setSessionUser(ben);
    const benBody = (await (await beat(outing.joinCode)).json()) as { here: string[] };
    expect(benBody.here.sort()).toEqual([anaSeat.participantId, (await seat(ben.id)).participantId].sort());

    const view = await getOutingView(db, outing, ben.id, await seat(ben.id));
    const byName = Object.fromEntries(view.members.map((m) => [m.handle, m]));
    expect(byName.ana_p).toMatchObject({ hereNow: true, friend: "add", isHost: false });
    expect(byName.host_p).toMatchObject({ hereNow: false, isHost: true });
    expect(byName.ben_p).toMatchObject({ isYou: true, friend: "you", showPresence: true });
    expect(JSON.stringify(view.members)).not.toMatch(/pour|amount|volume/i);
    void host;
  });

  it("presence ages out after two minutes", async () => {
    const { ana, ben, outing, seat } = await trip();
    const anaSeat = await seat(ana.id);
    await db.update(schema.outingParticipants).set({ lastSeenAt: new Date(Date.now() - 3 * 60_000) }).where(eq(schema.outingParticipants.id, anaSeat.participantId));
    setSessionUser(ben);
    const body = (await (await beat(outing.joinCode)).json()) as { here: string[] };
    expect(body.here).not.toContain(anaSeat.participantId);
  });

  it("outsiders and signed-out callers get 404; a bad body is 400", async () => {
    const { ana, outing } = await trip();
    expect((await beat(outing.joinCode)).status).toBe(404);
    setSessionUser(await person(db, "stranger_p"));
    expect((await beat(outing.joinCode)).status).toBe(404);
    setSessionUser(ana);
    expect((await beat(outing.joinCode, { show: "yes" })).status).toBe(400);
  });

  it("'Show when I'm here' off clears last_seen and hides the dot; on brings it back", async () => {
    const { ana, ben, outing, seat } = await trip();
    const anaSeat = await seat(ana.id);
    setSessionUser(ana);
    await beat(outing.joinCode);
    const off = (await (await beat(outing.joinCode, { show: false })).json()) as { here: string[]; show: boolean };
    expect(off).toEqual({ here: [], show: false });
    const row = await db.query.outingParticipants.findFirst({ where: eq(schema.outingParticipants.id, anaSeat.participantId) });
    expect(row).toMatchObject({ lastSeenAt: null, presenceHidden: true });
    await beat(outing.joinCode); // a plain heartbeat while off stores nothing
    expect((await db.query.outingParticipants.findFirst({ where: eq(schema.outingParticipants.id, anaSeat.participantId) }))?.lastSeenAt).toBeNull();

    setSessionUser(ben);
    expect(((await (await beat(outing.joinCode)).json()) as { here: string[] }).here).not.toContain(anaSeat.participantId);

    setSessionUser(ana);
    const on = (await (await beat(outing.joinCode, { show: true })).json()) as { here: string[]; show: boolean };
    expect(on.show).toBe(true);
    expect(on.here).toContain(anaSeat.participantId);
  });

  it("blocked people never see each other's presence; ended outings stop recording", async () => {
    const { host, ana, ben, outing, seat } = await trip();
    const anaSeat = await seat(ana.id);
    setSessionUser(ana);
    await beat(outing.joinCode);
    await blockUser(db, ben.id, ana.id);
    setSessionUser(ben);
    const body = (await (await beat(outing.joinCode)).json()) as { here: string[] };
    expect(body.here).not.toContain(anaSeat.participantId);

    await endOuting(db, host.id, outing.id);
    const ended = (await db.query.outings.findFirst({ where: eq(schema.outings.id, outing.id) }))!;
    const hostSeat = await seat(host.id);
    setSessionUser(host);
    expect((await beat(ended.joinCode)).status).toBe(200);
    expect((await db.query.outingParticipants.findFirst({ where: eq(schema.outingParticipants.id, hostSeat.participantId) }))?.lastSeenAt).toBeNull();
  });

  it("friend states follow the existing follow flow", async () => {
    const { ana, ben, outing, seat } = await trip();
    await followByHandle(db, ben.id, "ana_p");
    const view = await getOutingView(db, outing, ben.id, await seat(ben.id));
    const ana_ = view.members.find((m) => m.handle === "ana_p")!;
    expect(["requested", "following"]).toContain(ana_.friend);
    await followByHandle(db, ana.id, "ben_p");
    const view2 = await getOutingView(db, outing, ben.id, await seat(ben.id));
    const state = view2.members.find((m) => m.handle === "ana_p")!.friend;
    expect(["friends", "requested", "following"]).toContain(state);
  });
});
