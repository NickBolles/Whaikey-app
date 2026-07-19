"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Search, ScanLine, Wine, GlassWater, MessageCircle } from "lucide-react";

const TABS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/search", label: "Search", icon: Search },
  { href: "/scan", label: "Scan", icon: ScanLine },
  { href: "/bar", label: "My Bar", icon: Wine },
  { href: "/pour", label: "Pour", icon: GlassWater },
  { href: "/chat", label: "Chat", icon: MessageCircle },
] as const;

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="sticky bottom-0 z-40 mt-10 border-t border-border-subtle bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80"
    >
      <div className="grid grid-cols-6 pb-[env(safe-area-inset-bottom)]">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-col items-center gap-1 pt-3 pb-2.5 text-[11px] transition-colors ${
                active ? "text-accent" : "text-muted hover:text-foreground"
              }`}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute top-0 h-0.5 w-8 rounded-full bg-accent shadow-[0_0_8px_rgba(232,161,60,0.6)]"
                />
              )}
              <Icon size={20} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
