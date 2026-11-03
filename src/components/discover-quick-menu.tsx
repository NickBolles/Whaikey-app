"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Award, Disc3, GraduationCap, Search, Sparkles } from "lucide-react";
import { useScrollLock } from "@/lib/scroll-lock";

export interface QuickItem {
  href: string;
  label: string;
  icon: typeof Search;
}

/**
 * The arc, in order from the thumb's resting side. Ask drops out without AI;
 * Passport (it lives on your profile) drops out until you have a handle.
 */
export function quickItems(aiEnabled: boolean, passportHref?: string | null): QuickItem[] {
  return [
    ...(aiEnabled ? [{ href: "/chat", label: "Ask", icon: Sparkles }] : []),
    { href: "/learn", label: "Learn", icon: GraduationCap },
    { href: "/search", label: "Find", icon: Search },
    { href: "/learn/flavors", label: "Flavors", icon: Disc3 },
    ...(passportHref ? [{ href: passportHref, label: "Passport", icon: Award }] : []),
  ];
}

const RADIUS = 150;
const ITEM = 56;
const STEP_DEG = 30;

/**
 * Where each arc item sits (top-left of its 56px button) around the Discover
 * tab: centre 50px above the tab's top edge, fanning from due left (180°)
 * up and to the right in 30° steps, clamped inside the viewport so the last
 * item never clips the screen edge. Pure, so the geometry is unit-tested.
 */
export function arcPositions(count: number, tab: { left: number; top: number; width: number }, viewportWidth: number) {
  const cx = tab.left + tab.width / 2;
  const cy = tab.top - 50;
  return Array.from({ length: count }, (_, k) => {
    const a = ((180 - k * STEP_DEG) * Math.PI) / 180;
    const x = cx + RADIUS * Math.cos(a) - ITEM / 2;
    const y = cy - RADIUS * Math.sin(a) - ITEM / 2;
    return { left: Math.round(Math.max(8, Math.min(x, viewportWidth - ITEM - 10))), top: Math.round(y) };
  });
}

/**
 * The Discover quick menu (V3 radial on the V1 hub). A real menu: focus
 * moves to the first item, arrows and Tab cycle inside it, Esc or a tap on
 * the scrim closes it and returns focus to the tab. After a long-press the
 * finger can slide onto an item and let go to pick it.
 */
export function DiscoverQuickMenu({
  aiEnabled,
  passportHref = null,
  viaPress = false,
  onClose,
}: {
  aiEnabled: boolean;
  passportHref?: string | null;
  /** Opened by a long-press whose finger is still down: arm slide-and-release. */
  viaPress?: boolean;
  onClose: (restoreFocus: boolean) => void;
}) {
  useScrollLock(true);
  const router = useRouter();
  const items = quickItems(aiEnabled, passportHref);
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const picked = useRef(false);
  const [pos, setPos] = useState<{ left: number; top: number }[] | null>(null);

  useLayoutEffect(() => {
    const tab = document.querySelector<HTMLElement>("[data-discover-tab]");
    const r = tab?.getBoundingClientRect() ?? { left: window.innerWidth * 0.6, top: window.innerHeight - 64, width: window.innerWidth / 5 };
    // Measured once on open: the DOM is the source of truth for the tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPos(arcPositions(items.length, r, window.innerWidth));
  }, [items.length]);

  useEffect(() => {
    if (pos) refs.current[0]?.focus();
  }, [pos]);

  useEffect(() => {
    // Slide-and-release: the finger that long-pressed Discover lifting over
    // an item picks it. Only then — a later tap is an ordinary click.
    if (!viaPress) return;
    const onUp = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLAnchorElement>("[data-quick-item]");
      if (!el) return;
      picked.current = true;
      onClose(false);
      router.push(el.getAttribute("href") ?? "/discover");
    };
    document.addEventListener("pointerup", onUp, { once: true });
    return () => document.removeEventListener("pointerup", onUp);
  }, [viaPress, onClose, router]);

  const move = (from: number, delta: number) => {
    const n = items.length;
    refs.current[(from + delta + n) % n]?.focus();
  };

  return (
    <div className="fixed inset-0 z-[60]">
      <div aria-hidden data-testid="quick-menu-scrim" className="absolute inset-0 bg-black/60" onClick={() => onClose(true)} />
      <p className="sr-only" aria-live="polite">
        Discover shortcuts open
      </p>
      <div
        role="menu"
        aria-label="Discover shortcuts"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose(true);
          }
        }}
      >
        {pos &&
          items.map(({ href, label, icon: Icon }, i) => (
            <Link
              key={href}
              ref={(el) => {
                refs.current[i] = el;
              }}
              href={href}
              role="menuitem"
              data-quick-item
              onClick={(e) => {
                if (picked.current) {
                  e.preventDefault();
                  return;
                }
                onClose(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowUp" || (e.key === "Tab" && !e.shiftKey)) {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowDown" || (e.key === "Tab" && e.shiftKey)) {
                  e.preventDefault();
                  move(i, -1);
                }
              }}
              style={{ left: pos[i].left, top: pos[i].top }}
              className="absolute flex w-14 flex-col items-center gap-1 rounded-xl text-xs font-semibold text-foreground focus-visible:outline-none group"
            >
              <span
                className={`flex h-14 w-14 items-center justify-center rounded-full border shadow-[3px_3px_0_rgba(0,0,0,0.35)] group-focus-visible:ring-2 group-focus-visible:ring-accent ${
                  i === 0 ? "btn-primary border-accent-deep" : "border-border bg-surface text-accent"
                }`}
              >
                <Icon size={24} strokeWidth={1.8} aria-hidden />
              </span>
              <span className="rounded bg-background/80 px-1">{label}</span>
            </Link>
          ))}
      </div>
    </div>
  );
}
