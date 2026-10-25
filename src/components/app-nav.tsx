"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, Home, Plus, Users, Wine } from "lucide-react";
import { TABS as TAB_ROUTES, isChromeless, type TabHref } from "@/lib/app-routes";

// Home · Bar · ＋ · Explore · Social (STORYBOARD D1; design board C1). The
// destinations live in src/lib/app-routes.ts, which also tells the header a
// route is a tab (wordmark) or not (back button).
const TAB_ICONS: Record<TabHref, typeof Home> = {
  "/": Home,
  "/bar": Wine,
  "/search": Compass,
  "/friends": Users,
};
const NAV_LABELS: Partial<Record<TabHref, string>> = { "/bar": "Bar" };
const TABS = TAB_ROUTES.map((tab) => ({ ...tab, label: NAV_LABELS[tab.href] ?? tab.label, icon: TAB_ICONS[tab.href] }));

/**
 * The bottom nav. ＋ opens the Log a pour sheet directly, camera live
 * (design board S1, STORYBOARD Q1): the breakdown card it shows for an
 * unknown bottle already offers Add to bar and Wishlist, so a two-choice menu
 * in between would only cost a tap. Shelf-building (batch scan, import) lives
 * behind Bar → Add.
 */
export function AppNav() {
  const pathname = usePathname();
  // Same routes the header leaves out: sign-in, the welcome tour, share
  // pages, the age gate, the update screen and the pour sheet itself.
  if (isChromeless(pathname)) return null;

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <nav aria-label="Primary" data-app-nav className="sticky bottom-0 z-50 mt-6 border-t border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
      <div className="grid grid-cols-5 pb-[env(safe-area-inset-bottom)]">
        {TABS.slice(0, 2).map(({ href, label, icon: Icon }) => <NavLink key={href} href={href} label={label} Icon={Icon} active={isActive(href)} />)}
        <Link
          href="/pour"
          aria-label="Log a pour"
          className="flex flex-col items-center justify-center gap-0.5 py-1.5 text-xs text-foreground"
        >
          <span className="btn-primary flex h-9 w-12 items-center justify-center rounded-lg">
            <Plus size={22} strokeWidth={2.4} aria-hidden />
          </span>
        </Link>
        {TABS.slice(2).map(({ href, label, icon: Icon }) => <NavLink key={href} href={href} label={label} Icon={Icon} active={isActive(href)} />)}
      </div>
    </nav>
  );
}

function NavLink({ href, label, Icon, active }: { href: string; label: string; Icon: typeof Home; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative flex min-h-12 flex-col items-center justify-center gap-0.5 py-1.5 text-xs transition-colors ${active ? "text-accent" : "text-muted hover:text-foreground"}`}
    >
      {active && <span aria-hidden className="absolute top-0 h-0.5 w-8 rounded-full bg-accent" />}
      <Icon size={20} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
      {label}
    </Link>
  );
}
