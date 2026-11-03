"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Compass, Home, Plus, Users, Wine } from "lucide-react";
import { TABS as TAB_ROUTES, activeTab, isChromeless, isMarketingRoute, type TabHref } from "@/lib/app-routes";
import { DiscoverQuickMenu } from "@/components/discover-quick-menu";

// Home · Bar · ＋ · Discover · Social (STORYBOARD D1/D10, amended 2026-11-02;
// design board C1). The destinations live in src/lib/app-routes.ts, which
// also tells the header a route is a tab (wordmark) or not (back button).
const TAB_ICONS: Record<TabHref, typeof Home> = {
  "/": Home,
  "/bar": Wine,
  "/discover": Compass,
  "/friends": Users,
};
const NAV_LABELS: Partial<Record<TabHref, string>> = { "/bar": "Bar" };
const TABS = TAB_ROUTES.map((tab) => ({ ...tab, label: NAV_LABELS[tab.href] ?? tab.label, icon: TAB_ICONS[tab.href] }));

/** How long a press on Discover must last to open the quick menu. */
export const LONG_PRESS_MS = 450;

/**
 * The bottom nav. ＋ opens the Log a pour sheet directly, camera live
 * (design board S1, STORYBOARD Q1): the breakdown card it shows for an
 * unknown bottle already offers Add to bar and Wishlist, so a two-choice menu
 * in between would only cost a tap. Shelf-building (batch scan, import) lives
 * behind Bar → Add.
 *
 * Discover carries a quick menu (board caskfolk-discover-20261102, V1 + V3):
 * a long-press, or a second tap while Discover is already lit, fans Ask ·
 * Learn · Find · Flavors · Passport in an arc above the bar. A plain tap
 * always navigates, so the menu is a shortcut and never the only route.
 */
export function AppNav({
  signedIn = true,
  aiEnabled = false,
  passportHref = null,
}: { signedIn?: boolean; aiEnabled?: boolean; passportHref?: string | null } = {}) {
  const pathname = usePathname();
  const [menu, setMenu] = useState<null | "press" | "tap">(null);
  const discoverRef = useRef<HTMLAnchorElement>(null);
  // Same routes the header leaves out: sign-in, the welcome tour, share
  // pages, the age gate, the update screen and the pour sheet itself.
  if (isChromeless(pathname) || isMarketingRoute(pathname, signedIn)) return null;

  const current = activeTab(pathname);
  const closeMenu = (restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) discoverRef.current?.focus();
  };
  return (
    <nav aria-label="Primary" data-app-nav className="sticky bottom-0 z-50 mt-6 border-t border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
      <div className="mx-auto grid max-w-[480px] grid-cols-5 pb-[env(safe-area-inset-bottom)]">
        {TABS.slice(0, 2).map(({ href, label, icon: Icon }) => <NavLink key={href} href={href} label={label} Icon={Icon} active={current === href} />)}
        <Link
          href="/pour"
          aria-label="Log a pour"
          className="flex flex-col items-center justify-center gap-0.5 py-1.5 text-xs text-foreground"
        >
          <span className="btn-primary flex h-9 w-12 items-center justify-center rounded-lg">
            <Plus size={22} strokeWidth={2.4} aria-hidden />
          </span>
        </Link>
        {TABS.slice(2).map(({ href, label, icon: Icon }) =>
          href === "/discover" ? (
            <DiscoverTab
              key={href}
              linkRef={discoverRef}
              label={label}
              Icon={Icon}
              active={current === href}
              menuOpen={menu !== null}
              onOpenMenu={(how) => setMenu(how)}
            />
          ) : (
            <NavLink key={href} href={href} label={label} Icon={Icon} active={current === href} />
          ),
        )}
      </div>
      {menu && <DiscoverQuickMenu aiEnabled={aiEnabled} passportHref={passportHref} viaPress={menu === "press"} onClose={closeMenu} />}
    </nav>
  );
}

function DiscoverTab({
  linkRef,
  label,
  Icon,
  active,
  menuOpen,
  onOpenMenu,
}: {
  linkRef: React.RefObject<HTMLAnchorElement | null>;
  label: string;
  Icon: typeof Home;
  active: boolean;
  menuOpen: boolean;
  onOpenMenu: (how: "press" | "tap") => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <Link
      ref={linkRef}
      href="/discover"
      aria-current={active ? "page" : undefined}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-keyshortcuts="Shift+F10"
      data-discover-tab
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        longPressed.current = false;
        cancel();
        timer.current = setTimeout(() => {
          longPressed.current = true;
          onOpenMenu("press");
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      // The OS long-press menu (copy link, open in new tab) would cover ours.
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
        if (!longPressed.current) onOpenMenu("tap");
      }}
      onKeyDown={(e) => {
        if (e.key === "F10" && e.shiftKey) {
          e.preventDefault();
          onOpenMenu("tap");
        }
      }}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (longPressed.current) {
          // The press already opened the menu; its release isn't a tap.
          e.preventDefault();
          longPressed.current = false;
          return;
        }
        if (active) {
          // Second tap on a lit Discover opens the quick menu, which also
          // gives keyboard and switch users the shortcuts (Enter twice).
          e.preventDefault();
          onOpenMenu("tap");
        }
      }}
      className={`relative flex min-h-12 select-none flex-col items-center justify-center gap-0.5 py-1.5 text-xs transition-colors [-webkit-touch-callout:none] ${active ? "text-accent" : "text-muted hover:text-foreground"}`}
    >
      {active && <span aria-hidden className="absolute top-0 h-0.5 w-8 rounded-full bg-accent" />}
      <Icon size={20} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
      {label}
    </Link>
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
