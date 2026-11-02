"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ChevronRight, Star } from "lucide-react";
import { BottleArt } from "@/components/bottle-art";
import { PassportBadgeIcon } from "@/components/passport-badge";
import { QuickPourButton } from "@/components/quick-pour-button";
import { UserAvatar } from "@/components/user-avatar";
import type { PassportFamily } from "@/db/schema";
import {
  LATELY_TAB_STORAGE_KEY,
  buildFriendRows,
  buildYouRows,
  friendRowHref,
  friendRowSummary,
  pageRows,
  parseLatelyTab,
  type FriendActivityInput,
  type FriendRow,
  type LatelyTab,
  type OwnBadgeInput,
  type OwnPourInput,
  type YouRow,
} from "@/lib/home-feed";

export interface HomeOwnPour extends OwnPourInput {
  bottleCategory: string;
  bottleRegion: string | null;
  bottleCountry: string | null;
  bottleImageUrl: string | null;
}

export interface HomeLatelyProps {
  viewerId: string;
  pours: HomeOwnPour[];
  badge: (OwnBadgeInput & { family: PassportFamily }) | null;
  friendItems: FriendActivityInput[];
  hasProfile: boolean;
  hasFollows: boolean;
}

// The tab choice is remembered per device. Read through an external store so
// the server render and the first client paint both say "You" (no hydration
// mismatch) and the stored choice lands right after.
const TAB_EVENT = "caskfolk:lately-tab";

function subscribeTab(onChange: () => void) {
  window.addEventListener(TAB_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(TAB_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readStoredTab(): LatelyTab {
  try {
    return parseLatelyTab(window.localStorage.getItem(LATELY_TAB_STORAGE_KEY));
  } catch {
    return "you";
  }
}

function storeTab(tab: LatelyTab) {
  try {
    window.localStorage.setItem(LATELY_TAB_STORAGE_KEY, tab);
  } catch {
    // Private mode / storage off: the switch still works for this visit.
  }
  window.dispatchEvent(new Event(TAB_EVENT));
}

function noopSubscribe() {
  return () => {};
}

function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Day-granular on purpose: the feed never says who is drinking right now. */
function relativeDay(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Deterministic (UTC) date for your own rows, stable under the pinned-clock visual suite. */
function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function HomeLately({ viewerId, pours, badge, friendItems, hasProfile, hasFollows }: HomeLatelyProps) {
  const tab = useSyncExternalStore(subscribeTab, readStoredTab, () => "you" as LatelyTab);
  const [expanded, setExpanded] = useState<Record<LatelyTab, boolean>>({ you: false, friends: false });

  const youRows = buildYouRows(pours, badge);
  const friendRows = hasProfile && hasFollows ? buildFriendRows(friendItems, viewerId) : [];
  const poursById = new Map(pours.map((p) => [p.id, p]));

  return (
    <section aria-label="Lately" className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-label">Lately</h2>
        <div role="group" aria-label="Whose activity" className="lately-toggle" data-testid="lately-toggle">
          {(["you", "friends"] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => storeTab(t)}
              className="lately-toggle-btn"
            >
              {t === "you" ? "You" : "Friends"}
            </button>
          ))}
        </div>
      </div>

      {tab === "you" ? (
        <YouFeed rows={youRows} poursById={poursById} expanded={expanded.you} onExpand={() => setExpanded((e) => ({ ...e, you: true }))} />
      ) : (
        <FriendsFeed
          rows={friendRows}
          hasProfile={hasProfile}
          hasFollows={hasFollows}
          expanded={expanded.friends}
          onExpand={() => setExpanded((e) => ({ ...e, friends: true }))}
        />
      )}
    </section>
  );
}

function ShowMore({ hidden, onExpand, moreHref }: { hidden: number; onExpand: () => void; moreHref: string }) {
  return (
    <div className="flex items-center justify-between">
      {hidden > 0 ? (
        <button type="button" onClick={onExpand} className="tap-target text-sm font-medium text-accent hover:brightness-110">
          Show more
        </button>
      ) : (
        <span />
      )}
      <Link href={moreHref} className="tap-target text-sm text-muted transition-colors hover:text-foreground">
        See all →
      </Link>
    </div>
  );
}

function YouFeed({
  rows,
  poursById,
  expanded,
  onExpand,
}: {
  rows: YouRow[];
  poursById: Map<string, HomeOwnPour>;
  expanded: boolean;
  onExpand: () => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="card-flat p-4 text-sm text-muted" data-testid="lately-empty">
        Your tastings and badges land here as you go.
      </p>
    );
  }
  const { shown, hidden } = pageRows(rows, expanded);
  return (
    <>
      <ul className="card-flat divide-y divide-border-subtle" data-testid="lately-you">
        {shown.map((row) =>
          row.kind === "badge" ? (
            <li key={row.key} data-feed-card="badge">
              <Link href={row.badge.href} className="flex min-h-11 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-raised">
                <PassportBadgeIcon family={row.badge.family as PassportFamily} value={row.badge.value} tier={row.badge.tier} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    <span className="text-muted">Badge earned · </span>
                    <span className="font-medium">{row.badge.label}</span>
                    {row.badge.tierLabel && <span className="text-muted"> · {row.badge.tierLabel}</span>}
                  </span>
                  <span className="block truncate text-xs text-muted">{row.badge.detail}</span>
                </span>
                <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ) : (
            <OwnPourRow key={row.key} pour={poursById.get(row.pour.id) ?? (row.pour as HomeOwnPour)} />
          ),
        )}
      </ul>
      <ShowMore hidden={hidden} onExpand={onExpand} moreHref="/history" />
    </>
  );
}

function OwnPourRow({ pour }: { pour: HomeOwnPour }) {
  return (
    <li className="flex items-center gap-3 px-3 py-1.5" data-feed-card="pour">
      <BottleArt
        name={pour.bottleName}
        category={pour.bottleCategory}
        region={pour.bottleRegion}
        country={pour.bottleCountry}
        imageUrl={pour.bottleImageUrl}
        height={32}
      />
      <Link href={`/bottles/${pour.bottleId}`} className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{pour.bottleName}</span>
          <span className="block text-xs text-muted">{dayLabel(pour.createdAt)}</span>
        </span>
        {pour.rating != null && (
          <span className="flex shrink-0 items-center gap-1 text-accent">
            <Star size={12} fill="currentColor" aria-hidden />
            <span className="stat-number text-base leading-none">{pour.rating.toFixed(1)}</span>
          </span>
        )}
      </Link>
      <QuickPourButton bottleId={pour.bottleId} bottleName={pour.bottleName} />
    </li>
  );
}

function FriendsFeed({
  rows,
  hasProfile,
  hasFollows,
  expanded,
  onExpand,
}: {
  rows: FriendRow[];
  hasProfile: boolean;
  hasFollows: boolean;
  expanded: boolean;
  onExpand: () => void;
}) {
  const hydrated = useHydrated();
  if (!hasProfile || !hasFollows) {
    return (
      <Link href="/friends/people" className="card-flat flex min-h-11 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-raised" data-testid="lately-empty">
        <span className="min-w-0 flex-1 text-sm text-muted">Follow the people you drink with and their notes land here.</span>
        <span className="shrink-0 text-sm font-medium text-accent">Find friends</span>
      </Link>
    );
  }
  if (rows.length === 0) {
    // Invites sharing, never pouring (SOCIAL.md §3.1 rule 4).
    return (
      <p className="card-flat p-4 text-sm text-muted" data-testid="lately-empty">
        Quiet week from your friends. Share one of your own notes — that&rsquo;s usually how the conversation starts.
      </p>
    );
  }
  const { shown, hidden } = pageRows(rows, expanded);
  return (
    <>
      <ul className="card-flat divide-y divide-border-subtle" data-testid="lately-friends">
        {shown.map((row) => {
          const name = row.author.displayName || row.author.handle;
          const when = hydrated ? relativeDay(row.latestAt) : dayLabel(row.latestAt);
          return (
            <li key={row.key} data-feed-card={row.items.length > 1 ? "friend-group" : "friend"}>
              <Link href={friendRowHref(row)} className="flex min-h-11 items-center gap-2.5 px-3 py-2 transition-colors hover:bg-surface-raised">
                <UserAvatar name={name} image={row.author.avatarUrl} size={24} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">@{row.author.handle}</span>{" "}
                  <span className="text-foreground/80">{friendRowSummary(row)}</span>
                </span>
                <span className="shrink-0 text-xs text-muted">{when}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <ShowMore hidden={hidden} onExpand={onExpand} moreHref="/friends" />
    </>
  );
}
