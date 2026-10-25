import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type DB, schema } from "@/db";
import { createTestBottle, createTestUser, setupTestDb, uid } from "@/test/helpers";
import { resolveUpc } from "./scan";
import {
  PENDING_CLAIMS_PER_DAY,
  TRUSTED_MIN_PROMOTED,
  approvePendingBarcode,
  communitySuggestions,
  isTrustedTeacher,
  listPendingBarcodes,
  listPromotedBarcodes,
  rejectBarcodeClaim,
  shouldPromote,
  teachBarcode,
  upcConfirmationsRequired,
} from "./upc-crowd";

const UPC = "080244002145";
const OTHER_UPC = "082184090466";
const NOW = new Date("2026-10-25T12:00:00Z");
const OLD = new Date("2026-08-01T00:00:00Z");

let db: DB;
beforeEach(async () => {
  db = await setupTestDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const veteran = () => createTestUser(db, { createdAt: OLD });
const newcomer = () => createTestUser(db, { createdAt: new Date(NOW.getTime() - 2 * 86_400_000) });

async function suspend(userId: string) {
  await db.insert(schema.userProfiles).values({
    userId,
    handle: uid("h").replace(/[^a-z0-9_]/g, "").slice(0, 20),
    displayName: "S",
    suspendedAt: NOW,
  });
}

describe("shouldPromote", () => {
  it("needs the required count and a 2:1 lead over a competing claim", () => {
    expect(shouldPromote(1, 0, 2)).toBe(false);
    expect(shouldPromote(2, 0, 2)).toBe(true);
    expect(shouldPromote(2, 1, 2)).toBe(true);
    expect(shouldPromote(3, 2, 2)).toBe(false);
    expect(shouldPromote(4, 2, 2)).toBe(true);
  });

  it("reads the threshold from env with sane bounds", () => {
    expect(upcConfirmationsRequired({})).toBe(2);
    expect(upcConfirmationsRequired({ WHAIKEY_UPC_CONFIRMATIONS_REQUIRED: "3" })).toBe(3);
    expect(upcConfirmationsRequired({ WHAIKEY_UPC_CONFIRMATIONS_REQUIRED: "0" })).toBe(2);
  });
});

describe("teachBarcode", () => {
  it("one confirmation is pending and does not resolve for anyone", async () => {
    const bottle = await createTestBottle(db);
    const a = await veteran();
    const r = await teachBarcode(db, a, UPC, bottle.id, { now: NOW });
    expect(r).toMatchObject({ state: "pending", confirmations: 1, required: 2, mapping: null });
    expect(await resolveUpc(db, UPC)).toEqual([]);
  });

  it("two independent eligible accounts verify it", async () => {
    const bottle = await createTestBottle(db);
    await teachBarcode(db, await veteran(), UPC, bottle.id, { now: NOW });
    const r = await teachBarcode(db, await veteran(), UPC, bottle.id, { now: NOW });
    expect(r).toMatchObject({ state: "verified", confirmations: 2, taught: true });
    const matches = await resolveUpc(db, UPC);
    expect(matches.map((m) => m.id)).toEqual([bottle.id]);
    expect(matches[0]).toMatchObject({ source: "user", confirmedCount: 2 });
    const votes = await db.select().from(schema.upcConfirmations);
    expect(votes.every((v) => v.status === "promoted")).toBe(true);
  });

  it("the same account confirming twice is still one vote", async () => {
    const bottle = await createTestBottle(db);
    const a = await veteran();
    await teachBarcode(db, a, UPC, bottle.id, { now: NOW });
    const r = await teachBarcode(db, a, UPC, bottle.id, { now: NOW });
    expect(r.state).toBe("pending");
    expect(r.confirmations).toBe(1);
  });

  it("new accounts and suspended accounts do not count", async () => {
    const bottle = await createTestBottle(db);
    const fresh = await newcomer();
    const bad = await veteran();
    await suspend(bad.id);
    await teachBarcode(db, fresh, UPC, bottle.id, { now: NOW });
    await teachBarcode(db, bad, UPC, bottle.id, { now: NOW });
    const r = await teachBarcode(db, await veteran(), UPC, bottle.id, { now: NOW });
    expect(r).toMatchObject({ state: "pending", confirmations: 1 });
    expect(await resolveUpc(db, UPC)).toEqual([]);
  });

  it("a competing claim needs a clear majority", async () => {
    const right = await createTestBottle(db, { name: "Right" });
    const wrong = await createTestBottle(db, { name: "Wrong" });
    await teachBarcode(db, await veteran(), UPC, wrong.id, { now: NOW });
    await teachBarcode(db, await veteran(), UPC, right.id, { now: NOW });
    const tie = await teachBarcode(db, await veteran(), UPC, wrong.id, { now: NOW });
    // wrong 2 vs right 1 → 2 ≥ 2×1 → promoted; reflects a real 2:1 crowd.
    expect(tie.state).toBe("verified");
    const r = await teachBarcode(db, await veteran(), UPC, right.id, { now: NOW });
    // right 2 vs wrong 2 → not a clear lead.
    expect(r.state).toBe("pending");
  });

  it("changing your mind moves your vote", async () => {
    const one = await createTestBottle(db);
    const two = await createTestBottle(db);
    const a = await veteran();
    await teachBarcode(db, a, UPC, one.id, { now: NOW });
    await teachBarcode(db, a, UPC, two.id, { now: NOW });
    const votes = await db.select().from(schema.upcConfirmations);
    expect(votes).toHaveLength(1);
    expect(votes[0].bottleId).toBe(two.id);
  });

  it("an operator verifies alone", async () => {
    vi.stubEnv("WHAIKEY_OPERATOR_IDS", "op-1");
    const op = await createTestUser(db, { id: "op-1" });
    const bottle = await createTestBottle(db);
    const r = await teachBarcode(db, op, UPC, bottle.id, { now: NOW });
    expect(r.state).toBe("verified");
  });

  it("an established account with a clean record is trusted", async () => {
    const t = await veteran();
    for (let i = 0; i < TRUSTED_MIN_PROMOTED; i++) {
      const bottle = await createTestBottle(db);
      await db.insert(schema.upcConfirmations).values({
        id: uid("c"),
        upc: `0000000000${i}`,
        bottleId: bottle.id,
        userId: t.id,
        status: "promoted",
      });
    }
    expect(await isTrustedTeacher(db, t, NOW)).toBe(true);
    const bottle = await createTestBottle(db);
    expect((await teachBarcode(db, t, UPC, bottle.id, { now: NOW })).state).toBe("verified");
  });

  it("one rejected claim costs trust", async () => {
    const t = await veteran();
    for (let i = 0; i < TRUSTED_MIN_PROMOTED + 1; i++) {
      const bottle = await createTestBottle(db);
      await db.insert(schema.upcConfirmations).values({
        id: uid("c"),
        upc: `0000000001${i}`,
        bottleId: bottle.id,
        userId: t.id,
        status: i === 0 ? "rejected" : "promoted",
      });
    }
    expect(await isTrustedTeacher(db, t, NOW)).toBe(false);
  });

  it("caps new pending claims per account per day", async () => {
    const a = await veteran();
    const bottle = await createTestBottle(db);
    for (let i = 0; i < PENDING_CLAIMS_PER_DAY; i++) {
      await db.insert(schema.upcConfirmations).values({
        id: uid("c"),
        upc: `1000000000${String(i).padStart(2, "0")}`,
        bottleId: bottle.id,
        userId: a.id,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    const r = await teachBarcode(db, a, UPC, bottle.id, { now: NOW });
    expect(r.state).toBe("rate_limited");
    expect(await db.select().from(schema.upcConfirmations).where(eq(schema.upcConfirmations.upc, UPC))).toHaveLength(0);
  });

  it("confirming a known mapping strengthens it once per account", async () => {
    const bottle = await createTestBottle(db);
    await db.insert(schema.bottleUpcs).values({ id: uid("m"), upc: UPC, bottleId: bottle.id, source: "iowa", confirmedCount: 0 });
    const a = await newcomer();
    expect((await teachBarcode(db, a, UPC, bottle.id, { now: NOW })).state).toBe("strengthened");
    await teachBarcode(db, a, UPC, bottle.id, { now: NOW });
    const [m] = await db.select().from(schema.bottleUpcs);
    expect(m.confirmedCount).toBe(1);
  });
});

describe("community suggestions", () => {
  it("puts the viewer's own claim first and hides suspended voters", async () => {
    const mineB = await createTestBottle(db, { name: "Mine" });
    const theirsB = await createTestBottle(db, { name: "Theirs" });
    const spamB = await createTestBottle(db, { name: "Spam" });
    const me = await newcomer();
    await teachBarcode(db, me, UPC, mineB.id, { now: NOW });
    await teachBarcode(db, await veteran(), UPC, theirsB.id, { now: NOW });
    const spammer = await veteran();
    await teachBarcode(db, spammer, UPC, spamB.id, { now: NOW });
    await suspend(spammer.id);
    const s = await communitySuggestions(db, UPC, me.id);
    expect(s.map((x) => [x.name, x.mine])).toEqual([
      ["Mine", true],
      ["Theirs", false],
    ]);
  });

  it("is empty for other barcodes", async () => {
    const b = await createTestBottle(db);
    await teachBarcode(db, await veteran(), UPC, b.id, { now: NOW });
    expect(await communitySuggestions(db, OTHER_UPC)).toEqual([]);
  });
});

describe("operator moderation", () => {
  it("lists pending claims with eligible counts and competition", async () => {
    const a = await createTestBottle(db, { name: "A" });
    const b = await createTestBottle(db, { name: "B" });
    await teachBarcode(db, await newcomer(), UPC, a.id, { now: NOW });
    await teachBarcode(db, await veteran(), UPC, b.id, { now: NOW });
    const list = await listPendingBarcodes(db, NOW);
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.bottleName === "A")).toMatchObject({ votes: 1, eligibleVotes: 0, competing: 1 });
  });

  it("approve publishes; reject withdraws and stops the claim counting", async () => {
    const bottle = await createTestBottle(db);
    const a = await veteran();
    await teachBarcode(db, a, UPC, bottle.id, { now: NOW });
    expect(await approvePendingBarcode(db, UPC, bottle.id)).not.toBeNull();
    expect(await resolveUpc(db, UPC)).toHaveLength(1);
    expect(await approvePendingBarcode(db, UPC, bottle.id)).toBeNull(); // nothing pending any more

    expect(await rejectBarcodeClaim(db, UPC, bottle.id)).toBe(1);
    expect(await resolveUpc(db, UPC)).toEqual([]);
    // Repeating a rejected claim does not bring it back.
    const again = await teachBarcode(db, a, UPC, bottle.id, { now: NOW });
    expect(again.state).toBe("pending");
    expect(again.confirmations).toBe(0);
  });

  it("a rejected account cannot clear its rejection by claiming another bottle", async () => {
    const wrong = await createTestBottle(db, { name: "Wrong" });
    const right = await createTestBottle(db, { name: "Right" });
    const a = await veteran();
    await teachBarcode(db, a, UPC, wrong.id, { now: NOW });
    await rejectBarcodeClaim(db, UPC, wrong.id);
    const r = await teachBarcode(db, a, UPC, right.id, { now: NOW });
    expect(r.state).toBe("pending");
    const [row] = await db.select().from(schema.upcConfirmations).where(eq(schema.upcConfirmations.userId, a.id));
    expect(row).toMatchObject({ bottleId: wrong.id, status: "rejected" });
  });

  it("published claims stay listed for operator rejection", async () => {
    const bottle = await createTestBottle(db, { name: "Live" });
    await teachBarcode(db, await veteran(), UPC, bottle.id, { now: NOW });
    await teachBarcode(db, await veteran(), UPC, bottle.id, { now: NOW });
    expect(await listPendingBarcodes(db, NOW)).toHaveLength(0);
    const live = await listPromotedBarcodes(db, NOW);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ upc: UPC, bottleId: bottle.id, votes: 2 });
  });

  it("reject never deletes seed/import mappings", async () => {
    const bottle = await createTestBottle(db);
    await db.insert(schema.bottleUpcs).values({ id: uid("m"), upc: UPC, bottleId: bottle.id, source: "bc", confirmedCount: 0 });
    await rejectBarcodeClaim(db, UPC, bottle.id);
    expect(await resolveUpc(db, UPC)).toHaveLength(1);
  });
});

describe("communitySuggestions ordering", () => {
  it("keeps the viewer's own claim even with more than five competing claims", async () => {
    const viewer = await newcomer();
    for (let i = 0; i < 6; i++) {
      const b = await createTestBottle(db, { name: `Other ${i}` });
      await teachBarcode(db, await newcomer(), UPC, b.id, { now: NOW });
      await teachBarcode(db, await newcomer(), UPC, b.id, { now: NOW });
    }
    const mine = await createTestBottle(db, { name: "Zz Mine" });
    await teachBarcode(db, viewer, UPC, mine.id, { now: NOW });
    const list = await communitySuggestions(db, UPC, viewer.id);
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({ id: mine.id, mine: true });
  });
});
