"use client";

import { useState } from "react";
import { FeedCard, type FriendFeedItem } from "@/components/friends-module";

/**
 * The Friends-tab feed (docs/SOCIAL.md §7.3, D15): rich cards, newest first,
 * "Show more" pages through `/api/feed`. No infinite scroll — a calm list
 * you finish, not a slot machine (SOCIAL §3.1's spirit applied to the feed).
 */
export function SocialFeed({ initialItems, initialCursor }: { initialItems: FriendFeedItem[]; initialCursor: string | null }) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/feed?cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { items: FriendFeedItem[]; nextCursor: string | null };
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.pourId));
        return [...prev, ...json.items.filter((i) => !seen.has(i.pourId))];
      });
      setCursor(json.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Feed" className="flex flex-col gap-2.5">
      <ul className="flex flex-col gap-2.5">
        {items.map((item) => (
          <FeedCard key={item.pourId} item={item} />
        ))}
      </ul>
      {cursor ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={busy}
          className="btn-secondary tap-target self-center px-4 py-2 text-sm disabled:opacity-60"
        >
          {busy ? "Loading…" : "Show more"}
        </button>
      ) : (
        items.length > 0 && <p className="py-2 text-center text-xs text-muted">You&rsquo;re all caught up.</p>
      )}
      {failed && (
        <p role="status" className="text-center text-xs text-muted">
          Couldn&rsquo;t load more — try again.
        </p>
      )}
    </section>
  );
}
