"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Search } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import { BackButton } from "@/components/back-button";
import { isChromeless, isTabRoute, parentRoute } from "@/lib/app-routes";
import { BrandLockup } from "@/components/brand-mark";

/**
 * Global slim header, rendered once from the root layout above every page.
 * Server data (session user + own social profile handle) is fetched in
 * layout.tsx and passed down as props so this can stay a plain client
 * component — it needs usePathname to pick its leading slot and to suppress
 * itself on chromeless routes (src/lib/app-routes.ts).
 *
 * Leading slot (docs/STORYBOARD.md §1.1): the wordmark on tab routes, a back
 * button everywhere else. The trailing icons stay until the IA pass moves
 * search and the journal out of the header (STORYBOARD §5 step 8).
 *
 * Deliberately NOT sticky: DESIGN.md rule 10 reserves stickiness for the
 * bottom nav so full-page screenshots stay honest.
 */
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
  if (isChromeless(pathname)) return null;

  return (
    // Paper's masthead: a double rule under a plain ground, not a chrome bar.
    <header className="rule-double border-b-[3px] bg-background">
      <div className="flex h-12 items-center justify-between gap-2 pl-3 pr-1">
        {isTabRoute(pathname) ? (
          <Link
            href="/"
            className="font-display text-xl font-semibold tracking-tight text-foreground rounded-xl focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <BrandLockup size={20} />
          </Link>
        ) : (
          <BackButton fallback={parentRoute(pathname, { signedIn: Boolean(user), profileHandle })} />
        )}
        <div className="flex shrink-0 items-center">
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
