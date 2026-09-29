/**
 * The in-app navigation trail behind the header's back button.
 *
 * The browser's own history cannot answer the two questions back needs — "is
 * there an in-app page behind this one?" and "what was it?" — so the shell
 * keeps a parallel stack of pathnames: pushed on every in-app navigation,
 * unwound when a `popstate` (browser back, the iOS edge swipe, Android's back
 * button, `router.back()`) lands on an entry already in it.
 *
 * Kept in `sessionStorage` so a reload keeps its trail, and reset on a fresh
 * document load (a typed URL, a link from outside, a new tab) — the case where
 * `history.back()` would leave the app, and the header must fall back to the
 * route's logical parent instead.
 */

const STORAGE_KEY = "whaikey:nav-trail";
/** A trail is for going back a few screens, not an audit log. */
const MAX_ENTRIES = 50;

let trail: string[] | null = null;
let popPending = false;
const listeners = new Set<() => void>();

function load(): string[] {
  if (trail) return trail;
  trail = [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) trail = parsed.filter((p): p is string => typeof p === "string");
  } catch {
    // Storage blocked or corrupt: an empty trail only costs the history label.
  }
  return trail;
}

function commit(next: string[]): void {
  trail = next.slice(-MAX_ENTRIES);
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail));
  } catch {
    // Best effort, as above.
  }
  for (const listener of listeners) listener();
}

/** The next pathname change came from history traversal, not a push. */
export function markPopNavigation(): void {
  popPending = true;
}

/** Record that the app is now showing `pathname`. */
export function recordNavigation(pathname: string): void {
  const current = load();
  const wasPop = popPending;
  popPending = false;
  if (current[current.length - 1] === pathname) return;

  if (wasPop) {
    // Back (or several back): unwind to the entry we landed on. A pop that
    // lands somewhere not in the trail is a forward — treat it as a push.
    const at = current.lastIndexOf(pathname, current.length - 2);
    if (at >= 0) {
      commit(current.slice(0, at + 1));
      return;
    }
  }
  commit([...current, pathname]);
}

/** A fresh document: nothing in-app sits behind this page. */
export function resetNavigation(pathname: string): void {
  popPending = false;
  commit([pathname]);
}

/** The pathname one step back in the app, or null when there is none. */
export function previousPath(): string | null {
  if (typeof window === "undefined") return null;
  const current = load();
  return current.length >= 2 ? current[current.length - 2] : null;
}

export function subscribeNavigation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Was this document loaded by a plain navigation (typed URL, external link,
 * new tab)? A reload or a history traversal that missed the bfcache keeps the
 * trail it had. No entry at all (old browsers, jsdom) counts as fresh — the
 * safe answer, because it can only cost the history label, never strand
 * someone on a back button that leaves the app.
 */
export function isFreshDocumentLoad(): boolean {
  try {
    const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return !entry || entry.type === "navigate";
  } catch {
    return true;
  }
}

/** Test seam: forget the in-memory trail and the pending pop. */
export function resetNavHistoryForTests(): void {
  trail = null;
  popPending = false;
  listeners.clear();
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
