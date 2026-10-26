/**
 * When to offer push (docs/NATIVE_APP.md §3.2: "permission is requested
 * lazily, never on first launch").
 *
 * The moment that earns the ask is the first social interaction — a cheers,
 * a comment, a follow — because that is when there is somebody who might
 * answer. iOS gives exactly one system prompt, so the app first shows its own
 * card and only calls the OS when the person says yes. "Not now" is
 * respected: the card comes back at most once more, two weeks later.
 */

export const SOCIAL_INTERACTION_EVENT = "whaikey:social-interaction";
const KEY = "whaikey:push-offer:v1";
export const PUSH_OFFER_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const PUSH_OFFER_MAX = 2;

export interface PushOfferState {
  /** How many times the card has been shown. */
  shown: number;
  lastShownAt: number | null;
  /** The person said yes (or the OS answered): never offer again. */
  done: boolean;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadOfferState(): PushOfferState {
  try {
    const raw = storage()?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<PushOfferState>) : {};
    return {
      shown: typeof v.shown === "number" ? v.shown : 0,
      lastShownAt: typeof v.lastShownAt === "number" ? v.lastShownAt : null,
      done: v.done === true,
    };
  } catch {
    return { shown: 0, lastShownAt: null, done: false };
  }
}

export function saveOfferState(state: PushOfferState): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(state));
  } catch {}
}

/** Pure rule: may the card be shown now? */
export function mayOffer(state: PushOfferState, now: number): boolean {
  if (state.done || state.shown >= PUSH_OFFER_MAX) return false;
  if (state.lastShownAt != null && now - state.lastShownAt < PUSH_OFFER_COOLDOWN_MS) return false;
  return true;
}

/**
 * Social surfaces call this after a successful interaction. Fire-and-forget:
 * it only dispatches an event; `PushOffer` (mounted once in the layout)
 * decides whether anything is shown.
 */
export function notifySocialInteraction(kind: "cheers" | "comment" | "follow"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SOCIAL_INTERACTION_EVENT, { detail: { kind } }));
}
