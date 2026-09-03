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

beforeEach(async () => {
  localStorage.clear();
  await clearQueue();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Replies in the given order; anything beyond the list is a network failure. */
function mockFetchSequence(...responses: Array<Response | "network-error">) {
  let call = 0;
  const fn = vi.fn(async () => {
    const next = responses[call++] ?? "network-error";
    if (next === "network-error") throw new TypeError("Failed to fetch");
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ok = () => new Response(null, { status: 201 });
const status = (code: number) => new Response(null, { status: code });

describe("enqueue and persistence", () => {
  it("survives a reload by living in storage, not memory", async () => {
    await enqueuePour({ body: POUR, bottleName: "Ardbeg 10" });

    // Nothing in-process is consulted: the next read goes back to storage, the
    // same way it would after the OS kills a backgrounded app.
    expect(localStorage.getItem("whaikey.pour-queue.v1")).toContain("ardbeg-10");
    await expect(queueDepth()).resolves.toBe(1);
    const [entry] = await readQueue();
    expect(entry).toMatchObject({ body: POUR, bottleName: "Ardbeg 10", attempts: 0 });
  });

  it("keeps pours in the order they were logged", async () => {
    await enqueuePour({ body: { bottleId: "first" }, bottleName: "First" });
    await enqueuePour({ body: { bottleId: "second" }, bottleName: "Second" });
    expect((await readQueue()).map((entry) => entry.bottleName)).toEqual(["First", "Second"]);
  });

  it("recovers from corrupt storage instead of wedging pour logging", async () => {
    localStorage.setItem("whaikey.pour-queue.v1", "{not json");
    await expect(readQueue()).resolves.toEqual([]);
    await expect(enqueuePour({ body: POUR, bottleName: "Ardbeg 10" })).resolves.toBe(1);
  });
});

describe("flushPourQueue", () => {
  it("does nothing and touches no network when the queue is empty", async () => {
    const fetchMock = mockFetchSequence();
    await expect(flushPourQueue()).resolves.toEqual({ synced: 0, remaining: 0, discarded: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends everything and empties the queue when online", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A" });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B" });
    mockFetchSequence(ok(), ok());

    await expect(flushPourQueue()).resolves.toMatchObject({ synced: 2, remaining: 0 });
    await expect(queueDepth()).resolves.toBe(0);
  });

  it("stops at the first network failure and keeps the rest in order", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A" });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B" });
    await enqueuePour({ body: { bottleId: "c" }, bottleName: "C" });
    mockFetchSequence(ok(), "network-error");

    await expect(flushPourQueue()).resolves.toMatchObject({ synced: 1, remaining: 2 });
    // B must not be skipped over in favour of C — the timeline would reorder.
    expect((await readQueue()).map((entry) => entry.bottleName)).toEqual(["B", "C"]);
  });

  it("holds everything when the session has expired", async () => {
    await enqueuePour({ body: POUR, bottleName: "Ardbeg 10" });
    mockFetchSequence(status(401));

    await expect(flushPourQueue()).resolves.toMatchObject({ synced: 0, remaining: 1 });
    // Not the pour's fault, so it must not burn a retry attempt either.
    expect((await readQueue())[0].attempts).toBe(0);
  });

  it("does not spend an attempt on a server error", async () => {
    await enqueuePour({ body: POUR, bottleName: "Ardbeg 10" });
    mockFetchSequence(status(500));

    await expect(flushPourQueue()).resolves.toMatchObject({ synced: 0, remaining: 1 });
    expect((await readQueue())[0].attempts).toBe(0);
  });

  it("eventually drops a pour the server keeps rejecting, and reports it", async () => {
    await enqueuePour({ body: POUR, bottleName: "Ardbeg 10" });
    await enqueuePour({ body: { bottleId: "good" }, bottleName: "Good" });

    // A permanently-invalid row must not wedge the queue behind it forever...
    for (let attempt = 0; attempt < 4; attempt++) {
      mockFetchSequence(status(400));
      const result = await flushPourQueue();
      expect(result).toMatchObject({ synced: 0, remaining: 2, discarded: [] });
    }

    // ...but it is dropped loudly, not silently, and only after real persistence.
    mockFetchSequence(status(400), ok());
    const final = await flushPourQueue();
    expect(final.discarded.map((entry) => entry.bottleName)).toEqual(["Ardbeg 10"]);
    expect(final.synced).toBe(1);
    await expect(queueDepth()).resolves.toBe(0);
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
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A" });
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B" });
    const fetchMock = mockFetchSequence(ok(), ok());

    const [first, second, third] = await Promise.all([
      flushPourQueue(),
      flushPourQueue(),
      flushPourQueue(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Every caller gets the real result, not a "someone else is doing it" stub.
    expect(first).toMatchObject({ synced: 2, remaining: 0 });
    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(queueDepth()).resolves.toBe(0);
  });

  it("takes a fresh look at the queue once the previous flush has settled", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A" });
    mockFetchSequence(ok(), ok());

    await flushPourQueue();
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B" });
    await expect(flushPourQueue()).resolves.toMatchObject({ synced: 1, remaining: 0 });
  });

  /**
   * The user is in the bar. Signal flickers, a flush goes out, and they log the
   * next dram before it returns. Writing the flush's own snapshot back would
   * erase that pour — the exact silent loss this queue exists to prevent.
   */
  it("keeps a pour logged while the flush was out on the network", async () => {
    await enqueuePour({ body: { bottleId: "a" }, bottleName: "A" });

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

    const flush = flushPourQueue();
    await enqueuePour({ body: { bottleId: "b" }, bottleName: "B" });
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
