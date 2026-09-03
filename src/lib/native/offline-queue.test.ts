// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQueue,
  enqueuePour,
  flushPourQueue,
  isOnline,
  queueDepth,
  readQueue,
} from "./offline-queue";

/**
 * A queued pour is a note the user has already written and believes is saved
 * (docs/NATIVE_APP.md §3.1), so the bar for dropping one is high and the
 * ordering guarantees matter — pours are a timeline.
 */
const POUR = { bottleId: "ardbeg-10", rating: 4.5 };
/** The signed-in user for tests that aren't about who owns what. */
const ME = "user-me";

beforeEach(async () => {
  localStorage.clear();
  await clearQueue();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An entry as an older release wrote it: no owner, no clientId. */
async function writeLegacyEntry(entry: {
  id: string;
  body: unknown;
  bottleName: string;
  userId?: string;
}): Promise<void> {
  localStorage.setItem(
    "whaikey.pour-queue.v1",
    JSON.stringify([{ ...entry, queuedAt: "2026-08-01T00:00:00.000Z", attempts: 0 }]),
  );
}

/** Replies in the given order; anything beyond the list is a network failure. */
function mockFetchSequence(...responses: Array<Response | "network-error">) {
  let call = 0;
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    void init;
    const next = responses[call++] ?? "network-error";
    if (next === "network-error") throw new TypeError("Failed to fetch");
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The JSON body of the nth POST the mock received. */
function sentBody(fn: ReturnType<typeof mockFetchSequence>, n = 0): Record<string, unknown> {
  return JSON.parse(String(fn.mock.calls[n]?.[1]?.body));
}

const ok = () => new Response(null, { status: 201 });
const status = (code: number) => new Response(null, { status: code });

describe("enqueue and persistence", () => {
  it("survives a reload by living in storage, not memory", async () => {
    await enqueuePour({ body: POUR, bottleName: "Ardbeg 10", userId: ME });

    // Nothing in-process is consulted: the next read goes back to storage, the
    // same way it would after the OS kills a backgrounded app.
    expect(localStorage.getItem("whaikey.pour-queue.v1")).toContain("ardbeg-10");
    await expect(queueDepth()).resolves.toBe(1);
    const [entry] = await readQueue();
    expect(entry).toMatchObject({ body: POUR, bottleName: "Ardbeg 10", attempts: 0 });
  });

  it("keeps pours in the order they were logged", async () => {
    await enqueuePour({ body: { bottleId: "first" }, bottleName: "First", userId: ME });
    await enqueuePour({ body: { bottleId: "second" }, bottleName: "Second", userId: ME });
    expect((await readQueue()).map((entry) => entry.bottleName)).toEqual(["First", "Second"]);
  });

  it("recovers from corrupt storage instead of wedging pour logging", async () => {
    localStorage.setItem("whaikey.pour-queue.v1", "{not json");
    await expect(readQueue()).resolves.toEqual([]);
    await expect(enqueuePour({ body: POUR, bottleName: "Ardbeg 10", userId: ME })).resolves.toBe(1);
  });
});

describe("flushPourQueue", () => {
  it("does nothing and touches no network when the queue is empty", async () => {
    const fetchMock = mockFetchSequence();
    await expect(flushPourQueue(ME)).resolves.toEqual({
      synced: 0,
      remaining: 0,
      discarded: [],
      unclaimed: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends everything and empties the queue when online", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A", userId: ME });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B", userId: ME });
    mockFetchSequence(ok(), ok());

    await expect(flushPourQueue(ME)).resolves.toMatchObject({ synced: 2, remaining: 0 });
    await expect(queueDepth()).resolves.toBe(0);
  });

  it("stops at the first network failure and keeps the rest in order", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A", userId: ME });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B", userId: ME });
    await enqueuePour({ body: { bottleId: "c" }, bottleName: "C", userId: ME });
    mockFetchSequence(ok(), "network-error");

    await expect(flushPourQueue(ME)).resolves.toMatchObject({ synced: 1, remaining: 2 });
    // B must not be skipped over in favour of C — the timeline would reorder.
    expect((await readQueue()).map((entry) => entry.bottleName)).toEqual(["B", "C"]);
  });

  it("holds everything when the session has expired", async () => {
    await enqueuePour({ body: POUR, bottleName: "Ardbeg 10", userId: ME });
    mockFetchSequence(status(401));

    await expect(flushPourQueue(ME)).resolves.toMatchObject({ synced: 0, remaining: 1 });
    // Not the pour's fault, so it must not burn a retry attempt either.
    expect((await readQueue())[0].attempts).toBe(0);
  });

  it("does not spend an attempt on a server error", async () => {
    await enqueuePour({ body: POUR, bottleName: "Ardbeg 10", userId: ME });
    mockFetchSequence(status(500));

    await expect(flushPourQueue(ME)).resolves.toMatchObject({ synced: 0, remaining: 1 });
    expect((await readQueue())[0].attempts).toBe(0);
  });

  it("eventually drops a pour the server keeps rejecting, and reports it", async () => {
    await enqueuePour({ body: POUR, bottleName: "Ardbeg 10", userId: ME });
    await enqueuePour({ body: { bottleId: "good" }, bottleName: "Good", userId: ME });

    // A permanently-invalid row must not wedge the queue behind it forever...
    for (let attempt = 0; attempt < 4; attempt++) {
      mockFetchSequence(status(400));
      const result = await flushPourQueue(ME);
      expect(result).toMatchObject({ synced: 0, remaining: 2, discarded: [] });
    }

    // ...but it is dropped loudly, not silently, and only after real persistence.
    mockFetchSequence(status(400), ok());
    const final = await flushPourQueue(ME);
    expect(final.discarded.map((entry) => entry.bottleName)).toEqual(["Ardbeg 10"]);
    expect(final.synced).toBe(1);
    await expect(queueDepth()).resolves.toBe(0);
  });
});

describe("whose pour it is", () => {
  /**
   * Web storage is per *origin*, not per session. A pour queued offline by one
   * person and flushed after someone else signs in on the same browser would
   * land in the wrong account — their private note, in a stranger's journal.
   * On native this never mattered; on the web it does, and the web is exactly
   * where the flush was just switched on.
   */
  it("holds a pour belonging to someone else who used this browser", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A", userId: "alice" });
    const fetchMock = mockFetchSequence(ok());

    await expect(flushPourQueue("bob")).resolves.toMatchObject({ synced: 0, remaining: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    // Held, not dropped: it is still Alice's pour and still owed to her.
    expect((await readQueue())[0].attempts).toBe(0);
  });

  it("sends it once its owner is back", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A", userId: "alice" });
    mockFetchSequence(ok());
    await expect(flushPourQueue("alice")).resolves.toMatchObject({ synced: 1, remaining: 0 });
  });

  /**
   * The first cut of this stopped at a foreign entry to preserve ordering,
   * which stranded the signed-in user's own later pours behind it forever —
   * a worse failure than the one it was guarding against. There is no timeline
   * spanning two accounts for that ordering to protect.
   */
  it("keeps going past someone else's pour to reach this user's own", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "Alice's", userId: "alice" });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "Bob's first", userId: "bob" });
    await enqueuePour({ body: { bottleId: "c" }, bottleName: "Bob's second", userId: "bob" });
    const fetchMock = mockFetchSequence(ok(), ok());

    await expect(flushPourQueue("bob")).resolves.toMatchObject({ synced: 2, remaining: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Alice's is still there, still hers.
    expect((await readQueue()).map((entry) => entry.bottleName)).toEqual(["Alice's"]);
  });

  it("still stops at the first failure of this user's own, so their timeline holds", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "Alice's", userId: "alice" });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "Bob 1", userId: "bob" });
    await enqueuePour({ body: { bottleId: "c" }, bottleName: "Bob 2", userId: "bob" });
    await enqueuePour({ body: { bottleId: "d" }, bottleName: "Bob 3", userId: "bob" });
    mockFetchSequence(ok(), "network-error");

    await expect(flushPourQueue("bob")).resolves.toMatchObject({ synced: 1, remaining: 3 });
    expect((await readQueue()).map((entry) => entry.bottleName)).toEqual([
      "Alice's",
      "Bob 2",
      "Bob 3",
    ]);
  });

  /**
   * Written by a release that recorded no author. Sending it as whoever happens
   * to be signed in is right on a single-account device and writes a private
   * tasting note into a stranger's journal on a shared one. "Usually right" is
   * not a basis for that, so it is held and counted rather than guessed at.
   */
  it("holds a pour from before owners were recorded instead of guessing", async () => {
    await writeLegacyEntry({ id: "legacy-1", body: { bottleId: "a" }, bottleName: "A" });
    const fetchMock = mockFetchSequence(ok());

    await expect(flushPourQueue("whoever")).resolves.toMatchObject({
      synced: 0,
      remaining: 1,
      unclaimed: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let an unclaimed pour block the signed-in user's own", async () => {
    await writeLegacyEntry({ id: "legacy-1", body: { bottleId: "a" }, bottleName: "Legacy" });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "Mine", userId: "bob" });
    mockFetchSequence(ok());

    await expect(flushPourQueue("bob")).resolves.toMatchObject({
      synced: 1,
      remaining: 1,
      unclaimed: 1,
    });
    expect((await readQueue()).map((entry) => entry.bottleName)).toEqual(["Legacy"]);
  });
});

describe("legacy entries", () => {
  /**
   * Entries queued before `clientId` existed are precisely the ones that have
   * waited longest, and the first flush of one is the first chance to
   * double-log it. Stamp the queue id it already has (REL-4.2).
   */
  it("gives a pour with no idempotency key the one it already has", async () => {
    // Held entries still need a stable key for whenever they are claimed: the
    // key has to be the same on the first attempt and the last, or the
    // double-log comes back with them.
    await writeLegacyEntry({ id: "legacy-1", body: { bottleId: "a" }, bottleName: "A", userId: "bob" });
    const fetchMock = mockFetchSequence(ok());

    await flushPourQueue("bob");

    expect(sentBody(fetchMock)).toEqual({ bottleId: "a", clientId: "legacy-1" });
  });

  it("leaves a key the caller already minted alone", async () => {
    await enqueuePour({ body: { bottleId: "a", clientId: "minted-at-save" }, bottleName: "A", userId: ME });
    const fetchMock = mockFetchSequence(ok());

    await flushPourQueue(ME);

    expect(sentBody(fetchMock).clientId).toBe("minted-at-save");
  });
});

describe("concurrent flushes", () => {
  /**
   * Mount, `online` and app-resume all fire within a few ms of signal
   * returning. Without a single-flight guard each reads the same queue and
   * POSTs the same pours (REL-4.3) — the user's dram in the journal twice, and
   * the bottle two pours emptier.
   */
  it("collapses onto one flush, so a pour is sent once", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A", userId: ME });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B", userId: ME });
    const fetchMock = mockFetchSequence(ok(), ok());

    const [first, second, third] = await Promise.all([
      flushPourQueue(ME),
      flushPourQueue(ME),
      flushPourQueue(ME),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Every caller gets the real result, not a "someone else is doing it" stub.
    expect(first).toMatchObject({ synced: 2, remaining: 0 });
    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(queueDepth()).resolves.toBe(0);
  });

  it("takes a fresh look at the queue once the previous flush has settled", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A", userId: ME });
    mockFetchSequence(ok(), ok());

    await flushPourQueue(ME);
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B", userId: ME });
    await expect(flushPourQueue(ME)).resolves.toMatchObject({ synced: 1, remaining: 0 });
  });

  /**
   * The user is in the bar. Signal flickers, a flush goes out, and they log the
   * next dram before it returns. Writing the flush's own snapshot back would
   * erase that pour — the exact silent loss this queue exists to prevent.
   */
  it("keeps a pour logged while the flush was out on the network", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A", userId: ME });

    let releaseFirstSend: () => void = () => {};
    const sent = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await sent;
        return ok();
      }),
    );

    const flush = flushPourQueue(ME);
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B", userId: ME });
    releaseFirstSend();

    await expect(flush).resolves.toMatchObject({ synced: 1, remaining: 1 });
    expect((await readQueue()).map((entry) => entry.bottleName)).toEqual(["B"]);
  });
});

describe("isOnline", () => {
  it("trusts the browser, defaulting to online when it says nothing", () => {
    expect(isOnline()).toBe(true);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(isOnline()).toBe(false);
  });
});
