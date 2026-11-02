/**
 * Home's "Lately" feed (owner feedback 2026-11-02): one compact feed with a
 * small You | Friends switch instead of a badge card, a journal list and a
 * stack of full friend cards. This module is the pure assembly step — no DB,
 * no clock — so the rules below are unit-tested in one place.
 *
 * Ban list (docs/SOCIAL.md §3, AGENTS.md product guardrails) as it applies
 * here: rows describe what was tasted or earned, never how much or how often.
 * No streaks, no counts of pours, no volume badges, no "who's drinking now" —
 * friend rows carry a day-granular date, never minutes. Friend rows only come
 * from `getFriendFeed`, which already applies each pour's visibility tier,
 * blocks and suspensions; `buildFriendRows` re-checks the tier anyway so a
 * private pour can never reach the feed even if a caller passes one in.
 * Badges are the viewer's own only: a friend's tiers derive from pours they
 * never shared.
 */

export type LatelyTab = "you" | "friends";

export const LATELY_TABS: readonly LatelyTab[] = ["you", "friends"] as const;
export const LATELY_TAB_STORAGE_KEY = "caskfolk:home-lately-tab";
/** Rows shown before "Show more". */
export const LATELY_PAGE = 5;

/** Visibility tiers a friend's pour may carry and still be shown to a follower. */
const SHAREABLE = new Set(["friends", "followers", "public"]);

export interface OwnPourInput {
  id: string;
  bottleId: string;
  bottleName: string;
  rating: number | null;
  createdAt: string;
}

export interface OwnBadgeInput {
  label: string;
  /** e.g. "Explorer II" — tier name, never a count of pours. */
  tierLabel: string | null;
  detail: string;
  href: string;
  family: string;
  value: string;
  tier: number;
}

export interface FriendActivityInput {
  pourId: string;
  bottleId: string;
  bottleName: string;
  rating: number | null;
  createdAt: string;
  visibility?: string | null;
  author: { userId: string; handle: string; displayName: string; avatarUrl: string | null };
}

export type YouRow =
  | { kind: "badge"; key: string; badge: OwnBadgeInput }
  | { kind: "pour"; key: string; pour: OwnPourInput };

export interface FriendRow {
  key: string;
  author: FriendActivityInput["author"];
  /** Newest first. One entry renders as a single line; more collapse into one row. */
  items: FriendActivityInput[];
  latestAt: string;
}

/** Your side: the latest badge pinned first (it is date-free by design), then your recent tastings. */
export function buildYouRows(pours: OwnPourInput[], badge: OwnBadgeInput | null): YouRow[] {
  const rows: YouRow[] = [];
  if (badge) rows.push({ kind: "badge", key: `badge:${badge.family}:${badge.value}`, badge });
  const sorted = [...pours].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  for (const pour of sorted) rows.push({ kind: "pour", key: `pour:${pour.id}`, pour });
  return rows;
}

/**
 * Friends' side: shareable items only, the viewer's own items dropped, and
 * everything from the same friend collapsed into one row placed at that
 * friend's newest item — so one busy friend is one line, not a column.
 */
export function buildFriendRows(items: FriendActivityInput[], viewerId: string | null): FriendRow[] {
  const byAuthor = new Map<string, FriendRow>();
  const visible = items
    .filter((i) => i.visibility == null || SHAREABLE.has(i.visibility))
    .filter((i) => i.author.userId !== viewerId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  for (const item of visible) {
    const row = byAuthor.get(item.author.userId);
    if (row) {
      if (!row.items.some((x) => x.pourId === item.pourId)) row.items.push(item);
    } else {
      byAuthor.set(item.author.userId, {
        key: `friend:${item.author.userId}`,
        author: item.author,
        items: [item],
        latestAt: item.createdAt,
      });
    }
  }
  return [...byAuthor.values()];
}

/** The one line a friend row reads as: "rated Lagavulin 16", "tasted A and B", "tasted A, B and 2 more". */
export function friendRowSummary(row: FriendRow): string {
  const names = [...new Set(row.items.map((i) => i.bottleName))];
  if (row.items.length === 1) {
    return `${row.items[0].rating != null ? "rated" : "tasted"} ${names[0]}`;
  }
  if (names.length === 1) return `tasted ${names[0]}`;
  if (names.length === 2) return `tasted ${names[0]} and ${names[1]}`;
  return `tasted ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** Where a row goes: a single note opens that note; a collapsed group opens the friend's profile. */
export function friendRowHref(row: FriendRow): string {
  return row.items.length === 1 ? `/notes/${row.items[0].pourId}` : `/u/${row.author.handle}`;
}

/** First `LATELY_PAGE` rows unless expanded; `hidden` is how many "Show more" reveals. */
export function pageRows<T>(rows: T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || rows.length <= LATELY_PAGE) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, LATELY_PAGE), hidden: rows.length - LATELY_PAGE };
}

/** A stored tab choice, or the default (You) for anything unknown. */
export function parseLatelyTab(raw: string | null | undefined): LatelyTab {
  return raw === "friends" ? "friends" : "you";
}
