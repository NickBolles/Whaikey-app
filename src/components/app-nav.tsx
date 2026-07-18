"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Search, Wine, GlassWater, MessageCircle } from "lucide-react";

const TABS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/search", label: "Search", icon: Search },
  { href: "/bar", label: "My Bar", icon: Wine },
  { href: "/pour", label: "Pour", icon: GlassWater },
  { href: "/chat", label: "Chat", icon: MessageCircle },
] as const;

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 inset-x-0 z-40 border-t border-border-subtle bg-surface/95 backdrop-blur"
    >
      <div className="mx-auto max-w-2xl grid grid-cols-5">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-col items-center gap-1 py-2.5 text-[11px] transition-colors ${
                active ? "text-accent" : "text-muted hover:text-foreground"
              }`}
            >
              <Icon size={20} strokeWidth={active ? 2.4 : 1.8} aria-hidden />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
