"use client";

import { useEffect } from "react";
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

export function InboxList({ items }: { items: InboxItemJson[] }) {
  const unreadIds = items.filter((i) => !i.read).map((i) => i.id);
  const key = unreadIds.join(",");
  useEffect(() => {
    if (!key) return;
    void fetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: key.split(",") }),
    }).catch(() => {});
  }, [key]);

  return (
    <ul className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle">
      {items.map((item) => (
        <li key={item.id}>
          <Link href={item.deepLink} className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-raised">
            <UserAvatar name={item.actor?.displayName || item.actor?.handle || "Whaikey"} image={item.actor?.avatarUrl ?? null} size={32} />
            <span className={`min-w-0 flex-1 text-sm ${item.read ? "text-muted" : "text-foreground"}`}>{item.text}</span>
            <span className="shrink-0 text-xs text-muted" suppressHydrationWarning>
              {when(item.createdAt)}
            </span>
            {!item.read && <span aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
          </Link>
        </li>
      ))}
    </ul>
  );
}
