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

async function readRaw(): Promise<string | null> {
  const plugin = await loadPlugin(() => import("@capacitor/preferences"));
  if (plugin) {
    const { value } = await plugin.Preferences.get({ key: STORAGE_KEY });
    return value;
  }
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing or storage disabled — the queue degrades to in-flight only.
    return null;
  }
}

async function writeRaw(value: string): Promise<void> {
  const plugin = await loadPlugin(() => import("@capacitor/preferences"));
  if (plugin) {
    await plugin.Preferences.set({ key: STORAGE_KEY, value });
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, value);
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
  const raw = await readRaw();
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
  await writeRaw(JSON.stringify(queue));
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
  await serialize(() => writeQueue([]));
}

export interface FlushResult {
  synced: number;
  /** Still queued: either the network is still down, or they're mid-retry. */
  remaining: number;
  /** Dropped after MAX_ATTEMPTS of server rejection — surfaced, never silent. */
  discarded: QueuedPour[];
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
 * An entry with no owner predates the release that started recording one, and
 * — on the web — predates any flush at all, so it has been sitting unsent since
 * it was written. Sending it as whoever is signed in now is a guess, and on the
 * single-account device that is nearly every device it is the right one; the
 * alternative is stranding the pour permanently, which is the data loss this
 * queue exists to prevent. Entries written from here on always carry an owner,
 * so the guess expires with them.
 */
function belongsTo(entry: QueuedPour, userId: string | undefined): boolean {
  if (entry.userId === undefined) return true;
  return entry.userId === userId;
}

/**
 * The body to actually POST. Entries from before `clientId` existed carry none,
 * and they are exactly the ones that have been queued longest — so give them
 * the queue id they already have. Without it, flushing them for the first time
 * would reintroduce the double-log this release closes (REL-4.2).
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
  if (queue.length === 0) return { synced: 0, remaining: 0, discarded: [] };

  const discarded: QueuedPour[] = [];
  const handled = new Set<string>();
  let synced = 0;

  for (const entry of queue) {
    if (!belongsTo(entry, userId)) {
      // Someone else's pour on a shared browser: not ours to send and not ours
      // to delete, so leave it and carry on. Stopping here would strand this
      // user's own later pours behind it forever, and there is no timeline
      // that spans two accounts for the ordering to protect.
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

  return { synced, remaining: remaining.length, discarded };
}

/** Whether the device currently believes it has a connection. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}
