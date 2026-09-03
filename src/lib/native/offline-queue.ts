/**
 * Offline pour queue (docs/NATIVE_APP.md §3.1).
 *
 * PLAN.md §4.2 puts it plainly: "a bar basement has no signal." Logging a pour is
 * the core loop, and the moment it happens is exactly when the network is least
 * likely to be there. So a failed pour is not an error the user has to retry — it
 * is written to durable local storage and flushed when a connection returns.
 *
 * Storage is Capacitor Preferences on a device (survives app kills and OS
 * eviction better than web storage) and `localStorage` on the web, which gets the
 * same behaviour for the PWA and makes the whole thing testable in jsdom.
 *
 * Nothing here is native-only. A web or PWA user in the same bar basement
 * queues the same way and must be flushed the same way — see `NativeShell`,
 * which wires the flush for every platform.
 */
import { loadPlugin } from "./platform";

const STORAGE_KEY = "whaikey.pour-queue.v1";
/**
 * Where a pour goes when the queue gives up on it, instead of nowhere.
 *
 * A note the user wrote and was told was saved must not be destroyed by an
 * automatic background retry — and the flush now runs on its own on every
 * platform, so "the caller will surface it" was never going to happen by
 * itself. Quarantined entries are out of the send path but still on the
 * device, waiting for a surface that can show them (see `readQuarantine`).
 */
const QUARANTINE_KEY = "whaikey.pour-queue.failed.v1";

/** Give up on a pour that has failed this many times with a real server error. */
const MAX_ATTEMPTS = 5;

export interface QueuedPour {
  /** Local bookkeeping id — what identifies this entry within the queue. */
  id: string;
  /**
   * The exact `/api/pours` body, captured at the moment the user hit save. It
   * carries the `clientId` the caller minted before its first send attempt, so
   * replaying this entry after a lost response returns the original pour
   * rather than logging a second one (REL-4.2).
   */
  body: unknown;
  /**
   * Who wrote it. On the web this storage is per *origin*, not per session, so
   * without an owner a pour queued by one person and flushed after someone else
   * signs in on the same browser lands in the wrong account — their private
   * note, in a stranger's journal. Optional only because entries written by
   * releases before this one have none.
   */
  userId?: string;
  /** For showing "Ardbeg 10 · waiting to sync" without another lookup. */
  bottleName: string;
  queuedAt: string;
  attempts: number;
}

// --- storage ----------------------------------------------------------------

async function readRaw(key: string): Promise<string | null> {
  const plugin = await loadPlugin(() => import("@capacitor/preferences"));
  if (plugin) {
    const { value } = await plugin.Preferences.get({ key });
    return value;
  }
  try {
    return localStorage.getItem(key);
  } catch {
    // Private browsing or storage disabled — the queue degrades to in-flight only.
    return null;
  }
}

async function writeRaw(key: string, value: string): Promise<void> {
  const plugin = await loadPlugin(() => import("@capacitor/preferences"));
  if (plugin) {
    await plugin.Preferences.set({ key, value });
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota or disabled storage; nothing useful to do but keep the app working.
  }
}

/**
 * Every read-modify-write of the queue runs through here, one at a time.
 * Storage is async on both platforms, so without it a `enqueuePour` that reads
 * the queue before a flush writes its result back would save a snapshot taken
 * before the flush and resurrect pours that were already synced.
 */
let storageChain: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = storageChain.then(work, work);
  // Keep the chain alive after a rejection so one failure doesn't wedge it.
  storageChain = run.catch(() => undefined);
  return run;
}

export async function readQueue(): Promise<QueuedPour[]> {
  return parseEntries(await readRaw(STORAGE_KEY));
}

/**
 * Pours the queue gave up on, and pours whose author it cannot establish, are
 * both still the user's writing. This is what a recovery surface reads.
 */
export async function readQuarantine(): Promise<QueuedPour[]> {
  return parseEntries(await readRaw(QUARANTINE_KEY));
}

function parseEntries(raw: string | null): QueuedPour[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    // Corrupt or hand-edited storage must not brick pour logging forever.
    return Array.isArray(parsed) ? (parsed as QueuedPour[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedPour[]): Promise<void> {
  await writeRaw(STORAGE_KEY, JSON.stringify(queue));
}

/** Move entries out of the send path without destroying them. */
async function quarantine(entries: QueuedPour[]): Promise<void> {
  if (entries.length === 0) return;
  const existing = await readQuarantine();
  await writeRaw(QUARANTINE_KEY, JSON.stringify([...existing, ...entries]));
}

// --- queue operations -------------------------------------------------------

/** `crypto.randomUUID` needs a secure context, which an offline WebView may lack. */
function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Mint the idempotency key for one pour. The caller stamps it into the body
 * *before* the first send attempt and reuses it for every retry of that same
 * pour, which is what lets the server collapse a replay onto the original.
 */
export function newPourClientId(): string {
  return newId();
}

/** Add a pour that couldn't be sent. Returns the queue's new depth. */
export async function enqueuePour(entry: {
  body: unknown;
  bottleName: string;
  userId?: string;
}): Promise<number> {
  return serialize(async () => {
    const queue = await readQueue();
    queue.push({
      id: newId(),
      body: entry.body,
      bottleName: entry.bottleName,
      userId: entry.userId,
      queuedAt: new Date().toISOString(),
      attempts: 0,
    });
    await writeQueue(queue);
    return queue.length;
  });
}

export async function queueDepth(): Promise<number> {
  return (await readQueue()).length;
}

export async function clearQueue(): Promise<void> {
  await serialize(async () => {
    await writeQueue([]);
    await writeRaw(QUARANTINE_KEY, JSON.stringify([]));
  });
}

export interface FlushResult {
  synced: number;
  /** Still queued: either the network is still down, or they're mid-retry. */
  remaining: number;
  /**
   * Given up on after MAX_ATTEMPTS of server rejection. Moved to quarantine,
   * not deleted: an automatic retry must never be the thing that destroys a
   * note the user wrote and was told was saved. `readQuarantine()` still has
   * them.
   */
  discarded: QueuedPour[];
  /**
   * Queued by a release that recorded no author, so there is nobody to safely
   * send them as. Counted rather than sent, and counted rather than dropped:
   * the note is still on the device and still owed to whoever wrote it.
   */
  unclaimed: number;
}

let inFlight: Promise<FlushResult> | null = null;

/**
 * Try to send everything in the queue that belongs to `userId`.
 *
 * There is exactly one flush at a time. Three things call this — mount,
 * `online`, and returning to the app — and they routinely fire together when
 * signal comes back; without the guard each would read the same queue and POST
 * the same pours. Callers all get the same result, so none of them has to know
 * it wasn't the one doing the work.
 */
export function flushPourQueue(userId?: string): Promise<FlushResult> {
  inFlight ??= runFlush(userId).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Whether this entry is the current user's to send.
 *
 * An entry with no owner predates the release that started recording one. It is
 * tempting to send those as whoever is signed in now — on a single-account
 * device that is who wrote them, and the alternative leaves a pour unsent.
 * But "usually right" is not a basis for writing someone's private tasting note
 * into another person's journal, which is what the guess costs when it is
 * wrong, and it is wrong exactly where two people share a browser. Private by
 * default is not a probability.
 *
 * So they are held, and `FlushResult.unclaimed` says how many, so the app can
 * offer them to their author instead of quietly deciding on their behalf.
 */
function belongsTo(entry: QueuedPour, userId: string | undefined): boolean {
  return entry.userId !== undefined && entry.userId === userId;
}

/**
 * The body to actually POST. Entries from before `clientId` existed carry none,
 * so give them the queue id they already have — that key has to be stable from
 * the first attempt, whenever the entry is finally claimed and sent, or the
 * double-log this release closes comes back with it (REL-4.2).
 */
function bodyFor(entry: QueuedPour): unknown {
  const body = entry.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (typeof record.clientId === "string" && record.clientId) return body;
  return { ...record, clientId: entry.id };
}

/**
 * Ordering matters — pours are a timeline — so this stops at the first entry that
 * fails for network reasons rather than skipping ahead. A 4xx is different: the
 * server has judged the request itself, and retrying it forever would wedge the
 * queue behind one bad row, so those count against `MAX_ATTEMPTS` and are
 * eventually dropped and reported.
 */
async function runFlush(userId: string | undefined): Promise<FlushResult> {
  const queue = await readQueue();
  if (queue.length === 0) return { synced: 0, remaining: 0, discarded: [], unclaimed: 0 };

  const discarded: QueuedPour[] = [];
  const handled = new Set<string>();
  let synced = 0;
  let unclaimed = 0;

  for (const entry of queue) {
    if (!belongsTo(entry, userId)) {
      // Someone else's pour on a shared browser, or one with no author on
      // record: not ours to send and not ours to delete, so leave it and carry
      // on. Stopping here would strand this user's own later pours behind it
      // forever, and there is no timeline spanning two accounts for the
      // ordering to protect.
      if (entry.userId === undefined) unclaimed++;
      continue;
    }
    let response: Response;
    try {
      response = await fetch("/api/pours", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyFor(entry)),
      });
    } catch {
      // Still offline. Leave this entry and everything after it in place.
      break;
    }

    if (response.ok) {
      synced++;
      handled.add(entry.id);
      continue;
    }

    if (response.status === 401) {
      // Signed out: not the pour's fault, and retrying just burns attempts.
      // Hold everything until there's a session again.
      break;
    }

    if (response.status >= 500) {
      // Server-side problem — genuinely transient, so don't spend an attempt.
      break;
    }

    entry.attempts++;
    if (entry.attempts >= MAX_ATTEMPTS) {
      discarded.push(entry);
      handled.add(entry.id);
      continue;
    }
    // A 4xx that hasn't exhausted its attempts: stop so ordering holds, and let
    // the next flush try again.
    break;
  }

  // Merge rather than overwrite: the user can log another pour offline while
  // this flush is out on the network, and writing back our own snapshot would
  // silently drop it. Only the entries this flush actually settled are
  // removed; everything else in storage stays, in the order it is in now.
  const attempts = new Map(queue.map((entry) => [entry.id, entry.attempts]));
  const remaining = await serialize(async () => {
    const current = await readQueue();
    const kept = current
      .filter((entry) => !handled.has(entry.id))
      .map((entry) => {
        const tried = attempts.get(entry.id);
        return tried === undefined ? entry : { ...entry, attempts: tried };
      });
    await writeQueue(kept);
    return kept;
  });

  await serialize(() => quarantine(discarded));

  return { synced, remaining: remaining.length, discarded, unclaimed };
}

/** Whether the device currently believes it has a connection. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}
