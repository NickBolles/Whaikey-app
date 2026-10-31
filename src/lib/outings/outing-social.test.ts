import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { blockUser, createProfile } from "@/lib/social";
import { addOutingBottle, addTasting, createOuting, endOuting, findOutingSeat, getOutingView, joinOutingAsUser, outingChangeMarker } from "@/lib/outings";
import { POST as COMMENT } from "@/app/api/outings/[code]/comments/route";
import { DELETE as DEL, PATCH as EDIT } from "@/app/api/outings/[code]/comments/[id]/route";
import { POST as REACT } from "@/app/api/outings/[code]/reactions/route";

async function person(db: DB, handle: string) {
  const user = await createTestUser(db, { name: handle });
  await createProfile(db, user, handle);
  return user;
}
const input = { title: "Distillery Thursday", distilleryName: "Buffalo Trace", visitOn: "2026-10-29", rideReminder: true };
const p = (code: string, id?: string) => ({ params: Promise.resolve(id ? { code, id } : { code }) }) as never;

describe("outing replies and reactions", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
    setSessionUser(null);
  });

  async function trip() {
    const host = await person(db, "host_s");
    const ana = await person(db, "ana_s");
    const ben = await person(db, "ben_s");
    const bottle = await createTestBottle(db, { name: "Lagavulin 16" });
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, ana.id);
    await joinOutingAsUser(db, outing.id, ben.id);
    const anaSeat = (await findOutingSeat(db, outing.id, { userId: ana.id }))!;
    await addOutingBottle(db, outing, anaSeat, { bottleId: bottle.id });
    const t = (await addTasting(db, outing, anaSeat, { bottleId: bottle.id, rating: 4, note: "Smoke and pear" })) as { id: string };
    return { host, ana, ben, bottle, outing, tastingId: t.id, key: `b:${bottle.id}` };
  }

  it("members reply, @mention, react; edit/delete own; the host hides; the stream marker moves", async () => {
    const { host, ana, ben, outing, tastingId, key } = await trip();
    const before = await outingChangeMarker(db, outing.id);
    setSessionUser(ben);
    const res = await COMMENT(jsonRequest(`/api/outings/${outing.joinCode}/comments`, "POST", { targetKind: "tasting", targetId: tastingId, body: "Same pear here @ana_s" }), p(outing.joinCode));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await REACT(jsonRequest("/x", "POST", { targetKind: "bottle", targetId: key, kind: "want_to_try", on: true }), p(outing.joinCode))).status).toBe(200);
    expect((await REACT(jsonRequest("/x", "POST", { targetKind: "bottle", targetId: key, kind: "want_to_try", on: true }), p(outing.joinCode))).status).toBe(200);
    expect((await REACT(jsonRequest("/x", "POST", { targetKind: "bottle", targetId: key, kind: "cheers", on: true }), p(outing.joinCode))).status).toBe(400);
    expect(await outingChangeMarker(db, outing.id)).not.toBe(before);

    const anaView = await getOutingView(db, outing, ana.id, await findOutingSeat(db, outing.id, { userId: ana.id }));
    const c = anaView.social.comments[`tasting:${tastingId}`];
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ body: "Same pear here @ana_s", mentionsMe: true, mine: false });
    expect(anaView.social.reactions[`bottle:${key}`]).toMatchObject([{ kind: "want_to_try", count: 1 }]);

    // Edit / delete only your own.
    setSessionUser(ana);
    expect((await EDIT(jsonRequest("/x", "PATCH", { body: "hijack" }), p(outing.joinCode, id))).status).toBe(404);
    expect((await DEL(new Request("http://t/x", { method: "DELETE" }), p(outing.joinCode, id))).status).toBe(404);
    setSessionUser(ben);
    expect((await EDIT(jsonRequest("/x", "PATCH", { body: "Same pear, and honey" }), p(outing.joinCode, id))).status).toBe(200);
    // The host hides it.
    setSessionUser(host);
    expect((await DEL(new Request("http://t/x", { method: "DELETE" }), p(outing.joinCode, id))).status).toBe(200);
    const after = await getOutingView(db, outing, ana.id, await findOutingSeat(db, outing.id, { userId: ana.id }));
    expect(after.social.comments[`tasting:${tastingId}`]).toBeUndefined();
  });

  it("outsiders can't reply; blocked people never see each other's replies or reactions", async () => {
    const { ana, ben, outing, tastingId, key } = await trip();
    const stranger = await person(db, "stranger_s");
    setSessionUser(stranger);
    expect((await COMMENT(jsonRequest("/x", "POST", { targetKind: "bottle", targetId: key, body: "hi" }), p(outing.joinCode))).status).toBe(403);

    setSessionUser(ben);
    await COMMENT(jsonRequest("/x", "POST", { targetKind: "bottle", targetId: key, body: "from ben" }), p(outing.joinCode));
    await REACT(jsonRequest("/x", "POST", { targetKind: "bottle", targetId: key, kind: "agree", on: true }), p(outing.joinCode));
    await blockUser(db, ana.id, ben.id);
    const anaView = await getOutingView(db, outing, ana.id, await findOutingSeat(db, outing.id, { userId: ana.id }));
    expect(anaView.social.comments[`bottle:${key}`]).toBeUndefined();
    expect(anaView.social.reactions[`bottle:${key}`]).toBeUndefined();
    // And ben can't reply to ana's rating once blocked (the target is invisible to him).
    setSessionUser(ben);
    const r = await COMMENT(jsonRequest("/x", "POST", { targetKind: "tasting", targetId: tastingId, body: "still here?" }), p(outing.joinCode));
    expect([403, 404]).toContain(r.status);
  });

  it("replies close with the outing, and insights wait for enough data", async () => {
    const { host, ana, outing, key } = await trip();
    const view = await getOutingView(db, outing, ana.id, await findOutingSeat(db, outing.id, { userId: ana.id }));
    expect(view.insights?.waiting).toMatch(/at least 2 of the same bottles/);
    await endOuting(db, host.id, outing.id);
    setSessionUser(ana);
    expect((await COMMENT(jsonRequest("/x", "POST", { targetKind: "bottle", targetId: key, body: "late" }), p(outing.joinCode))).status).toBe(409);
  });
});
