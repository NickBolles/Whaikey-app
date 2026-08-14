"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { BookmarkPlus, MessageCircle, Star, Wine } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import { compareFlavorNotes } from "@/lib/flavor-compare";

// `relativeDate` below reads the clock, so — like recommendation-rail.tsx and
// history-timeline.tsx — this must be a client component: a server component
// would bake "3 days ago" into the server's real wall-clock time at request
// time, which drifts (and crosses "days"/"weeks"/"months" bucket boundaries)
// independent of the fixed timestamps in the seed. Being a client component
// alone isn't sufficient, though: Next still server-renders it for the first
// paint using real time, and a test's fake `page.clock` only takes effect in
// the browser, so that first paint and the post-hydration client render can
// disagree — a hydration mismatch. `useHydrated` below defers the
// clock-dependent text to a post-mount render so SSR and the first client
// paint always match (same fix as comment-thread.tsx's `formatRelativeTime`).

function noopSubscribe() {
  return () => {};
}

function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Nudge a wedge hue toward the warm brass palette (kept in sync with history-timeline.tsx). */
function warmify(hex: string): string {
  const warm = [185, 141, 79]; // brass midpoint (#b98d4f)
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = rgb.map((c, i) => Math.round(c * 0.78 + warm[i] * 0.22));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const wedgeColor = new Map(FLAVOR_WHEEL.map((w) => [w.id, warmify(w.color)]));

export interface FriendFeedAuthor {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Serialized FeedItem (src/lib/social.ts) crossing the server→client boundary. */
export interface FriendFeedItem {
  pourId: string;
  bottleId: string;
  bottleName: string;
  author: FriendFeedAuthor;
  rating: number | null;
  servingStyle: string | null;
  createdAt: string;
  nose: string | null;
  palate: string | null;
  finish: string | null;
  freeform: string | null;
  flavorTags: Record<string, number> | null;
  cheersCount: number;
  commentCount: number;
  viewerTags: Record<string, number> | null;
  viewerBottleRelationship: "own" | "tried" | "wishlist" | null;
}

export interface FriendsModuleProps {
  items: FriendFeedItem[];
  /** The viewer has claimed a handle (a prerequisite for the graph to mean anything). */
  hasProfile: boolean;
  /** The viewer follows at least one accepted friend/followee. */
  hasFollows: boolean;
}

function relativeDate(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return months <= 1 ? "1 month ago" : `${months} months ago`;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * §7.3's "you tasted this too" line, computed from the viewer's own union
 * tags on the bottle vs. this friend's note. Names up to 2-3 descriptors
 * total across the two clauses so it reads as one warm sentence, not a data dump.
 */
function comparisonLine(
  viewerTags: Record<string, number>,
  flavorTags: Record<string, number> | null,
): string {
  const { both, onlyTheirs } = compareFlavorNotes(viewerTags, flavorTags);
  const agreed = both
    .flatMap((g) => g.leafIds)
    .map(leafLabel)
    .filter((l): l is string => Boolean(l))
    .slice(0, 2);
  const theirsOnly = onlyTheirs
    .flatMap((g) => g.leafIds)
    .map(leafLabel)
    .filter((l): l is string => Boolean(l));

  const clauses: string[] = [];
  if (agreed.length > 0) clauses.push(`you agreed on ${joinAnd(agreed)}`);
  if (theirsOnly.length > 0) clauses.push(`they got ${theirsOnly[0]} you didn't`);

  if (clauses.length === 0) return "You tasted this too — different descriptors, same bottle.";
  return `You tasted this too — ${clauses.join(", ")}.`;
}

function noteSnippet(item: FriendFeedItem): string | null {
  const text = item.freeform ?? item.nose ?? item.palate ?? item.finish;
  if (!text) return null;
  return text.length > 140 ? `${text.slice(0, 140).trimEnd()}…` : text;
}

function FeedCard({ item }: { item: FriendFeedItem }) {
  const snippet = noteSnippet(item);
  const tags = item.flavorTags ? Object.entries(item.flavorTags).slice(0, 4) : [];
  const hasComparison = item.viewerTags != null && Object.keys(item.viewerTags).length > 0;
  // US-7: the discovery card carries a one-tap wishlist action of its own.
  const [wishlisted, setWishlisted] = useState(item.viewerBottleRelationship === "wishlist");
  const [wishlistBusy, setWishlistBusy] = useState(false);
  const isWishlisted = wishlisted;
  const showWishlistAction = !hasComparison && !isWishlisted && item.viewerBottleRelationship == null;

  async function handleWishlist() {
    if (wishlistBusy || wishlisted) return;
    setWishlistBusy(true);
    try {
      const res = await fetch("/api/user-bottles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bottleId: item.bottleId, relationship: "wishlist" }),
      });
      if (res.ok) setWishlisted(true);
    } catch {
      // Quietly keep the button; the note page offers the same action.
    } finally {
      setWishlistBusy(false);
    }
  }

  const hydrated = useHydrated();
  const dateLabel = hydrated
    ? relativeDate(item.createdAt)
    : new Date(item.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <li className="card-flat flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <UserAvatar name={item.author.displayName || item.author.handle} image={item.author.avatarUrl} size={28} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
              <Link href={`/u/${item.author.handle}`} className="font-medium hover:text-accent transition-colors">
                @{item.author.handle}
              </Link>
              <span className="text-muted">·</span>
              <Link
                href={`/bottles/${item.bottleId}`}
                className="min-w-0 truncate text-muted hover:text-foreground transition-colors"
              >
                {item.bottleName}
              </Link>
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {[item.servingStyle, dateLabel].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>
        {item.rating != null && (
          <span className="flex shrink-0 items-center gap-1 text-accent">
            <Star size={13} fill="currentColor" aria-hidden />
            <span className="stat-number text-base leading-none">{item.rating.toFixed(1)}</span>
          </span>
        )}
      </div>

      {snippet && <p className="text-sm italic text-muted">&ldquo;{snippet}&rdquo;</p>}

      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Flavor tags">
          {tags.map(([leafId]) => (
            <li key={leafId} className="chip flex items-center gap-1.5 px-2.5 py-1 text-xs">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: wedgeColor.get(wedgeForLeaf(leafId) ?? "") ?? "var(--muted)" }}
                aria-hidden
              />
              <span className="text-foreground/90">{leafLabel(leafId) ?? leafId}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-sm text-foreground/85">
          {hasComparison
            ? comparisonLine(item.viewerTags as Record<string, number>, item.flavorTags)
            : isWishlisted
              ? "On your wishlist."
              : item.viewerBottleRelationship === "own" || item.viewerBottleRelationship === "tried"
                ? "You've had this one — no flavor notes of yours to compare yet."
                : "New to you — see what they thought."}
        </p>
        <span className="flex shrink-0 items-center gap-3">
          {showWishlistAction && (
            <button
              type="button"
              onClick={handleWishlist}
              disabled={wishlistBusy}
              className="tap-target inline-flex items-center gap-1 text-xs font-medium text-accent hover:brightness-110 transition-[filter] disabled:opacity-60"
            >
              <BookmarkPlus size={13} strokeWidth={1.8} aria-hidden /> Wishlist
            </button>
          )}
          <Link
            href={`/notes/${item.pourId}`}
            className="text-xs font-medium text-accent hover:brightness-110 transition-[filter]"
          >
            {hasComparison ? "Compare notes →" : "See the note →"}
          </Link>
        </span>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="flex items-center gap-1">
          <Wine size={12} strokeWidth={1.8} aria-hidden /> {item.cheersCount}
        </span>
        <span className="flex items-center gap-1">
          <MessageCircle size={12} strokeWidth={1.8} aria-hidden /> {item.commentCount}
        </span>
      </div>
    </li>
  );
}

/**
 * US-7: the "From your friends" Home module (docs/SOCIAL.md §7.3) — a
 * sparse-first module, not a feed tab. `items` is server-fetched via
 * getFriendFeed and passed in as serializable props so this stays testable.
 */
export function FriendsModule({ items, hasProfile, hasFollows }: FriendsModuleProps) {
  const showInvite = !hasProfile || !hasFollows;

  return (
    <section aria-label="From your friends">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="section-label">From your friends</h2>
        <Link href="/friends" className="text-xs text-muted hover:text-foreground transition-colors">
          {hasFollows ? "Manage" : "Find friends"}
        </Link>
      </div>

      {showInvite ? (
        <div className="card flex flex-col items-center gap-3 p-6 text-center">
          <span aria-hidden className="text-3xl">
            🤝
          </span>
          <p className="font-display text-lg font-semibold">Notes are better shared</p>
          <p className="max-w-xs text-sm text-muted">
            Follow a few friends to see their tastes alongside yours — a comparison, not a feed.
          </p>
          <Link href="/friends" className="btn-secondary px-5 py-2.5 text-sm font-medium">
            Find friends
          </Link>
        </div>
      ) : items.length === 0 ? (
        <div className="card-flat p-4">
          <p className="text-sm text-muted">Quiet week — nothing shared yet.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {items.map((item) => (
            <FeedCard key={item.pourId} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}
