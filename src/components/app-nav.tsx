"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { GlassWater, Home, MessageCircle, Plus, ScanLine, Search, Users, Wine, X } from "lucide-react";
import { useScrollLock } from "@/lib/scroll-lock";

// Search lives in the global header and the ＋ quick-actions sheet, not here
// (2026-08 IA redesign; docs/SOCIAL.md §6.3 amendment covers the Friends slot).
const TABS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/bar", label: "My Bar", icon: Wine },
  { href: "/friends", label: "Friends", icon: Users },
  { href: "/chat", label: "Chat", icon: MessageCircle },
] as const;

const QUICK_ACTIONS = [
  { href: "/pour", label: "Log a pour", description: "Choose a bottle, then capture the moment.", icon: GlassWater },
  { href: "/scan", label: "Scan a bottle", description: "Add a bottle to your shelf.", icon: ScanLine },
  { href: "/search", label: "Find a bottle", description: "Browse the whiskey library.", icon: Search },
] as const;

/**
 * The age gate is a blocking screen (PLAN.md §9.1): every tab behind it
 * redirects straight back to it, so a nav here is five ways to end up in the
 * same place. Only `/age` — the nav also renders on `/welcome` and `/sign-in`,
 * which the review lists as its own bug and Lane B's to fix, and fixing it
 * here would quietly reflow both of those baselines.
 */
const HIDDEN_ROUTES = ["/age"];

export function AppNav() {
  const pathname = usePathname();
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsPanelRef = useRef<HTMLDivElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  useScrollLock(actionsOpen);

  const hidden = HIDDEN_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  const closeActions = () => {
    actionsTriggerRef.current?.focus();
    setActionsOpen(false);
  };

  useEffect(() => {
    if (!actionsOpen) return;
    const panel = actionsPanelRef.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeActions();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [actionsOpen]);

  // Hooks first: an early return above them would change the hook order
  // between routes, which React forbids.
  if (hidden) return null;

  return (
    <>
      {actionsOpen && (
        <div className="fixed inset-0 z-[60] flex items-end bg-black/55 px-4 pb-24" role="dialog" aria-modal="true" aria-label="Quick actions">
          <button className="absolute inset-0" type="button" aria-label="Dismiss quick actions" onClick={closeActions} />
          <div ref={actionsPanelRef} className="card relative z-10 mx-auto w-full max-w-md p-3 shadow-2xl">
            <div className="flex items-center justify-between px-2 pb-2">
              <p className="section-label">Do something with your bar</p>
              <button type="button" className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-surface-raised hover:text-foreground" aria-label="Close quick actions" onClick={closeActions}>
                <X size={18} aria-hidden />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {QUICK_ACTIONS.map(({ href, label, description, icon: Icon }) => (
                <Link key={href} href={href} onClick={closeActions} className="flex items-center gap-3 rounded-xl p-3 hover:bg-surface-raised">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><Icon size={19} aria-hidden /></span>
                  <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted mt-0.5">{description}</span></span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
      <nav aria-label="Primary" className="sticky bottom-0 z-50 mt-10 border-t border-border-subtle bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
        <div className="grid grid-cols-5 pb-[env(safe-area-inset-bottom)]">
          {TABS.slice(0, 2).map(({ href, label, icon: Icon }) => <NavLink key={href} href={href} label={label} Icon={Icon} active={href === "/" ? pathname === "/" : pathname.startsWith(href)} />)}
          <button ref={actionsTriggerRef} type="button" onClick={() => setActionsOpen(true)} aria-expanded={actionsOpen} aria-haspopup="dialog" aria-label="Open quick actions" className="relative -mt-5 flex flex-col items-center gap-1 pb-2.5 text-[11px] text-foreground"><span className="flex h-12 w-12 items-center justify-center rounded-full border-4 border-background bg-accent text-background shadow-[0_0_16px_rgba(232,161,60,0.4)]"><Plus size={24} strokeWidth={2.5} aria-hidden /></span>New</button>
          {TABS.slice(2).map(({ href, label, icon: Icon }) => <NavLink key={href} href={href} label={label} Icon={Icon} active={pathname.startsWith(href)} />)}
        </div>
      </nav>
    </>
  );
}

function NavLink({ href, label, Icon, active }: { href: string; label: string; Icon: typeof Home; active: boolean }) {
  return <Link href={href} aria-current={active ? "page" : undefined} className={`relative flex flex-col items-center gap-1 pt-3 pb-2.5 text-[11px] transition-colors ${active ? "text-accent" : "text-muted hover:text-foreground"}`}>{active && <span aria-hidden className="absolute top-0 h-0.5 w-8 rounded-full bg-accent shadow-[0_0_8px_rgba(232,161,60,0.6)]" />}<Icon size={20} strokeWidth={active ? 2.2 : 1.8} aria-hidden />{label}</Link>;
}
