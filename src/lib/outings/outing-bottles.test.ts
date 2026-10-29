import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { createTestBottle, createTestUser, jsonRequest, mockSessionModule, setSessionUser, setupTestDb } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import { blockUser, createProfile } from "@/lib/social";
import {
  addOutingBottle,
  addTasting,
  buildBottleBoard,
  createOuting,
  endOuting,
  findOutingSeat,
  getOutingView,
  joinOutingAsUser,
  outingBottleKey,
  removeOutingBottle,
  visibleOutingByCode,
} from "@/lib/outings";
import { POST as ADD } from "@/app/api/outings/[code]/bottles/route";
import { DELETE as REMOVE } from "@/app/api/outings/[code]/bottles/[id]/route";

async function person(db: DB, handle: string) {
  const user = await createTestUser(db, { name: handle });
  await createProfile(db, user, handle);
  return user;
}
const input = { title: "Distillery Thursday", distilleryName: "Buffalo Trace", visitOn: "2026-10-29", rideReminder: true };
const p = (code: string, id?: string) => ({ params: Promise.resolve(id ? { code, id } : { code }) }) as never;

describe("outing bottle list", () => {
  let db: DB;
  beforeEach(async () => {
    db = await setupTestDb();
    setSessionUser(null);
  });

  it("dedupes: the same bottle (or the same typed name) added twice is one entry", async () => {
    const host = await person(db, "host_l");
    const friend = await person(db, "friend_l");
    const bottle = await createTestBottle(db, { name: "Eagle Rare 10" });
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, friend.id);
    const hostSeat = (await findOutingSeat(db, outing.id, { userId: host.id }))!;
    const friendSeat = (await findOutingSeat(db, outing.id, { userId: friend.id }))!;

    const a = await addOutingBottle(db, outing, hostSeat, { bottleId: bottle.id });
    const b = await addOutingBottle(db, outing, friendSeat, { bottleId: bottle.id });
    expect(a).toMatchObject({ existed: false });
    expect(b).toMatchObject({ existed: true, id: (a as { id: string }).id });
    await addOutingBottle(db, outing, hostSeat, { label: "Cask 1142  Sample" });
    expect(await addOutingBottle(db, outing, friendSeat, { label: "cask 1142 sample" })).toMatchObject({ existed: true });
    expect(await addOutingBottle(db, outing, friendSeat, { bottleId: "nope" })).toEqual({ error: "bottle_not_found" });

    // A tasting of a bottle not on the list puts it there for everyone.
    const other = await createTestBottle(db, { name: "Blanton's" });
    await addTasting(db, outing, friendSeat, { bottleId: other.id, rating: 4 });

    const view = await getOutingView(db, outing, host.id, hostSeat);
    expect(view.board.map((x) => x.label)).toEqual(["Eagle Rare 10", "Cask 1142  Sample", "Blanton's"]);
    expect(view.board[0]).toMatchObject({ addedBy: "You", addedByMe: true, notYet: ["You", "friend_l"], votes: [] });
    expect(view.board[2].addedBy).not.toBe("You");

    await endOuting(db, host.id, outing.id);
    const ended = (await visibleOutingByCode(db, outing.joinCode, host.id))!;
    expect(await addOutingBottle(db, ended, hostSeat, { label: "Too late" })).toEqual({ error: "not_open" });
  });

  it("group view: everyone's rating, note and tags, average, favourite, 'not yet' — and no amounts", async () => {
    const host = await person(db, "host_g");
    const friend = await person(db, "friend_g");
    const third = await person(db, "third_g");
    const er = await createTestBottle(db, { name: "Eagle Rare 10" });
    const bt = await createTestBottle(db, { name: "Buffalo Trace" });
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, friend.id);
    await joinOutingAsUser(db, outing.id, third.id);
    const hostSeat = (await findOutingSeat(db, outing.id, { userId: host.id }))!;
    const friendSeat = (await findOutingSeat(db, outing.id, { userId: friend.id }))!;
    await addOutingBottle(db, outing, hostSeat, { bottleId: er.id });
    await addOutingBottle(db, outing, friendSeat, { bottleId: bt.id });
    await addTasting(db, outing, hostSeat, { bottleId: er.id, rating: 4, flavorTags: { vanilla: 2 }, note: "Cherry cola" });
    await addTasting(db, outing, friendSeat, { bottleId: er.id, rating: 5, flavorTags: { vanilla: 1, oak: 2 } });
    await addTasting(db, outing, friendSeat, { bottleId: bt.id, rating: 3 });

    const view = await getOutingView(db, outing, friend.id, friendSeat);
    const erRow = view.board.find((x) => x.label === "Eagle Rare 10")!;
    expect(erRow.average).toBe(4.5);
    expect(erRow.favourite).toBe(true);
    expect(erRow.votes.map((v) => [v.who, v.rating])).toEqual([
      ["host_g", 4],
      ["You", 5],
    ]);
    expect(erRow.votes[0].note).toBe("Cherry cola");
    expect(erRow.groupTags[0]).toBe("Vanilla");
    expect(erRow.notYet).toEqual(["third_g"]);
    expect(erRow.mine).toMatchObject({ rating: 5 });
    expect(view.board.find((x) => x.label === "Buffalo Trace")!.favourite).toBe(false);
    // Responsible-drinking hard rules: nothing on the board is a tally or an amount.
    expect(JSON.stringify(view.board)).not.toMatch(/count|ml|oz|amount|volume|pours?\b|streak/i);
  });

  it("blocked and hidden people drop out of the board; removals are your own (host hides)", async () => {
    const host = await person(db, "host_v");
    const friend = await person(db, "friend_v");
    const other = await person(db, "other_v");
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, friend.id);
    await joinOutingAsUser(db, outing.id, other.id);
    const friendSeat = (await findOutingSeat(db, outing.id, { userId: friend.id }))!;
    const otherSeat = (await findOutingSeat(db, outing.id, { userId: other.id }))!;
    const added = (await addOutingBottle(db, outing, friendSeat, { label: "Cask sample" })) as { id: string };
    await addTasting(db, outing, friendSeat, { label: "Cask sample", rating: 4 });
    await blockUser(db, other.id, friend.id);
    const otherView = await getOutingView(db, outing, other.id, otherSeat);
    expect(otherView.board).toEqual([]);
    expect(await removeOutingBottle(db, outing, otherSeat, false, added.id)).toBe(false);
    expect(await removeOutingBottle(db, outing, null, true, added.id)).toBe(true);
    // The tasting stays, so the bottle still shows from it — but not as anyone's list entry.
    const hostView = await getOutingView(db, outing, host.id, await findOutingSeat(db, outing.id, { userId: host.id }));
    expect(hostView.board.map((b) => [b.label, b.entryId])).toEqual([["Cask sample", null]]);
  });

  it("pure board: one voice per person (their latest), legacy tastings appear, key normalises", () => {
    const t0 = new Date("2026-10-29T10:00:00Z");
    const t1 = new Date("2026-10-29T11:00:00Z");
    expect(outingBottleKey(null, "  Cask  1142 ")).toBe("l:cask 1142");
    expect(outingBottleKey("b1", "x")).toBe("b:b1");
    const board = buildBottleBoard(
      [],
      [
        { id: "t1", participantId: "p1", bottleId: "b1", label: "ER", rating: 2, flavorTags: null, note: null, createdAt: t0, updatedAt: t0 },
        { id: "t2", participantId: "p1", bottleId: "b1", label: "ER", rating: 5, flavorTags: null, note: null, createdAt: t1, updatedAt: t1 },
        { id: "t3", participantId: "ghost", bottleId: "b1", label: "ER", rating: 1, flavorTags: null, note: null, createdAt: t1, updatedAt: t1 },
      ],
      [
        { participantId: "p1", name: "A" },
        { participantId: "p2", name: "B" },
      ],
      "p2",
    );
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ entryId: null, average: 5, notYet: ["B"], favourite: true, mine: null });
    expect(board[0].votes).toHaveLength(1);
  });

  it("routes: add needs a seat, is idempotent (201 then 200), delete is owner/host only", async () => {
    const host = await person(db, "host_r");
    const friend = await person(db, "friend_r");
    const stranger = await person(db, "stranger_r");
    const bottle = await createTestBottle(db, { name: "Weller 12" });
    const outing = await createOuting(db, host.id, input);
    await joinOutingAsUser(db, outing.id, friend.id);
    const url = `/api/outings/${outing.joinCode}/bottles`;

    setSessionUser(stranger);
    expect((await ADD(jsonRequest(url, "POST", { bottleId: bottle.id }), p(outing.joinCode))).status).toBe(403);
    setSessionUser(friend);
    expect((await ADD(jsonRequest(url, "POST", {}), p(outing.joinCode))).status).toBe(400);
    const first = await ADD(jsonRequest(url, "POST", { bottleId: bottle.id }), p(outing.joinCode));
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    setSessionUser(host);
    expect((await ADD(jsonRequest(url, "POST", { bottleId: bottle.id }), p(outing.joinCode))).status).toBe(200);
    setSessionUser(stranger);
    expect((await REMOVE(jsonRequest(`${url}/${id}`, "DELETE"), p(outing.joinCode, id))).status).toBe(403);
    setSessionUser(friend);
    expect((await REMOVE(jsonRequest(`${url}/${id}`, "DELETE"), p(outing.joinCode, id))).status).toBe(200);
  });
});
