"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UserAvatar } from "@/components/user-avatar";

export interface InboxItemJson {
  id: string;
  category: string;
  text: string;
  deepLink: string;
  createdAt: string;
  read: boolean;
  actor: { handle: string; displayName: string; avatarUrl: string | null } | null;
}

function when(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Opening the inbox clears the badge: everything unread is marked read on
 * view (the rows keep their unread dot for this visit). Older entries page in
 * through "Show older".
 */
export function InboxList({ items: initial, hasUnread, pageSize }: { items: InboxItemJson[]; hasUnread: boolean; pageSize: number }) {
  const [items, setItems] = useState(initial);
  const [more, setMore] = useState(initial.length >= pageSize);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hasUnread) return;
    void fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }, [hasUnread]);

  async function older() {
    const last = items[items.length - 1];
    if (!last || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/notifications?before=${encodeURIComponent(`${last.createdAt}~${last.id}`)}`);
      const json = (await res.json()) as { items: InboxItemJson[] };
      setItems((prev) => [...prev, ...json.items.filter((i) => !prev.some((p) => p.id === i.id))]);
      setMore(json.items.length > 0);
    } catch {
      // Leave the button; a retry is one tap.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle">
        {items.map((item) => (
          <li key={item.id}>
            <Link href={item.deepLink} className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-raised">
              <UserAvatar
                name={item.actor?.displayName || item.actor?.handle || "Whaikey"}
                image={item.actor?.avatarUrl ?? null}
                size={32}
              />
              <span className={`min-w-0 flex-1 text-sm ${item.read ? "text-muted" : "text-foreground"}`}>{item.text}</span>
              <span className="shrink-0 text-xs text-muted" suppressHydrationWarning>
                {when(item.createdAt)}
              </span>
              {!item.read && <span aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
            </Link>
          </li>
        ))}
      </ul>
      {more && (
        <button type="button" onClick={() => void older()} disabled={busy} className="btn-secondary self-center px-4 py-2 text-sm disabled:opacity-60">
          {busy ? "Loading…" : "Show older"}
        </button>
      )}
    </div>
  );
}
