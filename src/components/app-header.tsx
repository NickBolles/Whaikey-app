"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Search } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";

/**
 * Global slim header, rendered once from the root layout above every page.
 * Server data (session user + own social profile handle) is fetched in
 * layout.tsx and passed down as props so this can stay a plain client
 * component — it needs usePathname to suppress itself on immersive routes.
 *
 * Deliberately NOT sticky: DESIGN.md rule 10 reserves stickiness for the
 * bottom nav so full-page screenshots stay honest.
 */
const HIDDEN_ROUTES = ["/welcome", "/sign-in", "/age"];

export interface AppHeaderUser {
  name: string;
  image?: string | null;
}

export function AppHeader({
  user,
  profileHandle,
}: {
  user: AppHeaderUser | null;
  /** The signed-in user's social handle, when they have claimed one. */
  profileHandle: string | null;
}) {
  const pathname = usePathname();
  if (HIDDEN_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return null;
  }

  return (
    <header className="border-b border-border-subtle bg-surface">
      <div className="flex h-14 items-center justify-between pl-4 pr-1.5">
        <Link
          href="/"
          className="font-display text-lg font-semibold text-foreground rounded-xl focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <span aria-hidden className="mr-1.5">
            🥃
          </span>
          Whaikey
        </Link>
        <div className="flex items-center">
          <HeaderAction href="/search" label="Search">
            <Search size={20} strokeWidth={1.8} aria-hidden />
          </HeaderAction>
          {user && (
            <>
              <HeaderAction href="/history" label="Journal">
                <BookOpen size={20} strokeWidth={1.8} aria-hidden />
              </HeaderAction>
              <HeaderAction href={profileHandle ? `/u/${profileHandle}` : "/friends"} label="Your profile">
                <UserAvatar name={user.name} image={user.image} size={26} />
              </HeaderAction>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/** Quiet 44px icon target (DESIGN.md rule 8). */
function HeaderAction({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      {children}
    </Link>
  );
}
