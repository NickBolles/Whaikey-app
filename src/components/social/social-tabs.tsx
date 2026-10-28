"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell } from "lucide-react";
import { TRAIL } from "@/lib/challenges/term";
import { MyCodeButton } from "@/components/my-code-button";

/**
 * The Friends tab's sub-navigation (design board decision C1: Feed · Clubs ·
 * Trails (D23), with people controls in the header — STORYBOARD D15). Slices
 * that have not shipped yet are simply absent rather than teased.
 */
export const SOCIAL_TABS = [
  { href: "/friends", label: "Feed" },
  { href: "/clubs", label: "Clubs" },
  { href: TRAIL.path, label: TRAIL.many },
  { href: "/friends/people", label: "People" },
] as const;

/**
 * `handle` (when the page has it) skips the sheet's profile read; the "My
 * code" QR button sits beside the bell on every Social sub-page.
 */
export function SocialTabs({ unread, handle }: { unread: number; handle?: string | null }) {
  const pathname = usePathname() ?? "/friends";
  return (
    <div className="flex items-center justify-between gap-2">
      <nav aria-label="Social sections" className="flex min-w-0 gap-0.5 rounded-xl bg-surface-raised p-1">
        {SOCIAL_TABS.map((tab) => {
          const active = tab.href === "/friends" ? pathname === "/friends" : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`tap-target whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
                active ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex shrink-0 items-center">
      <MyCodeButton handle={handle} />
      <Link
        href="/notifications"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="tap-target relative flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-raised hover:text-foreground"
      >
        <Bell size={20} strokeWidth={1.8} aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-1 top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-background"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Link>
      </div>
    </div>
  );
}
