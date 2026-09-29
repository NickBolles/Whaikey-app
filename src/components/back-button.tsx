"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { ChevronLeft } from "lucide-react";
import { routeLabel, type ParentRoute } from "@/lib/app-routes";
import { previousPath, subscribeNavigation } from "@/lib/nav-history";

const serverSnapshot = () => null;

/**
 * The header's back slot on non-tab routes (docs/STORYBOARD.md §1.1): "← back,
 * labelled with where you came from".
 *
 * Two answers to "where": when the app knows the page behind this one it says
 * that page's name and goes back through history, so scroll position and
 * client state come back with it — the same step the iOS edge swipe and
 * Android's back button take. With no in-app history (a deep link, a fresh
 * tab) it is a plain link to the route's logical parent, which is also what
 * the server renders, so first paint never waits on the client and a
 * no-JS or pre-hydration tap still goes somewhere sensible.
 */
export function BackButton({ fallback }: { fallback: ParentRoute }) {
  const router = useRouter();
  const previous = useSyncExternalStore(subscribeNavigation, previousPath, serverSnapshot);
  const label = previous ? routeLabel(previous) : fallback.label;

  return (
    <Link
      href={previous ?? fallback.href}
      onClick={(event) => {
        if (!previous) return;
        // Leave modified clicks (new tab, new window) to the browser.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        router.back();
      }}
      aria-label={label ? `Back to ${label}` : "Back"}
      className="-ml-2 flex h-11 min-w-11 max-w-[14rem] items-center gap-0.5 rounded-xl pl-1 pr-2 text-sm text-muted transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent/60"
      data-testid="header-back"
    >
      <ChevronLeft size={20} strokeWidth={1.8} aria-hidden className="shrink-0" />
      <span className="truncate">{label ?? "Back"}</span>
    </Link>
  );
}
