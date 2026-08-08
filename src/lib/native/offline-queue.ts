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
 */
import { loadPlugin } from "./platform";

const STORAGE_KEY = "whaikey.pour-queue.v1";

/** Give up on a pour that has failed this many times with a real server error. */
const MAX_ATTEMPTS = 5;

export interface QueuedPour {
  /**
   * Local bookkeeping id. Note this is *not* an idempotency key — `/api/pours`
   * has none, so a flush whose response is lost in transit leaves the entry
   * queued and can double-log on the next attempt. Narrow window, but real;
   * closing it needs a server-side key (docs/NATIVE_APP.md §4, Phase 3).
   */
  id: string;
  /** The exact `/api/pours` body, captured at the moment the user hit save. */
  body: unknown;
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

/** Add a pour that couldn't be sent. Returns the queue's new depth. */
export async function enqueuePour(entry: {
  body: unknown;
  bottleName: string;
}): Promise<number> {
  const queue = await readQueue();
  queue.push({
    id: newId(),
    body: entry.body,
    bottleName: entry.bottleName,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  });
  await writeQueue(queue);
  return queue.length;
}

export async function queueDepth(): Promise<number> {
  return (await readQueue()).length;
}

export async function clearQueue(): Promise<void> {
  await writeQueue([]);
}

export interface FlushResult {
  synced: number;
  /** Still queued: either the network is still down, or they're mid-retry. */
  remaining: number;
  /** Dropped after MAX_ATTEMPTS of server rejection — surfaced, never silent. */
  discarded: QueuedPour[];
}

/**
 * Try to send everything in the queue.
 *
 * Ordering matters — pours are a timeline — so this stops at the first entry that
 * fails for network reasons rather than skipping ahead. A 4xx is different: the
 * server has judged the request itself, and retrying it forever would wedge the
 * queue behind one bad row, so those count against `MAX_ATTEMPTS` and are
 * eventually dropped and reported.
 */
export async function flushPourQueue(): Promise<FlushResult> {
  const queue = await readQueue();
  if (queue.length === 0) return { synced: 0, remaining: 0, discarded: [] };

  const discarded: QueuedPour[] = [];
  let synced = 0;
  let index = 0;

  for (; index < queue.length; index++) {
    const entry = queue[index];
    let response: Response;
    try {
      response = await fetch("/api/pours", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.body),
      });
    } catch {
      // Still offline. Leave this entry and everything after it in place.
      break;
    }

    if (response.ok) {
      synced++;
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
      continue;
    }
    // A 4xx that hasn't exhausted its attempts: stop so ordering holds, and let
    // the next flush try again.
    break;
  }

  const handled = new Set([
    ...queue.slice(0, index).map((entry) => entry.id),
    ...discarded.map((entry) => entry.id),
  ]);
  const remaining = queue.filter((entry) => !handled.has(entry.id));
  await writeQueue(remaining);

  return { synced, remaining: remaining.length, discarded };
}

/** Whether the device currently believes it has a connection. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}
