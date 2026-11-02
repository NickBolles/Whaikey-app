"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A horizontal card row that lines its first card up with the page gutter
 * (owner feedback 2026-11-02: "all the way up against the left side").
 *
 * The row bleeds to the screen edge (`-mx-4`) so cards can scroll under it,
 * and gets the gutter back twice: `px-4` for the resting position and
 * `scroll-px-4` (scroll-padding-inline) so `snap-start` snaps cards to the
 * gutter instead of to the screen edge — without the scroll padding,
 * mandatory snapping pulled the first card flush left.
 *
 * A subtle right-edge fade (mask-image, `.h-scroller[data-more]`) says there
 * is more to scroll, and only while there is. The row is focusable and
 * labelled so a keyboard user can arrow through it; touch scrolls natively.
 */
export function measureMore(el: Pick<HTMLElement, "scrollLeft" | "scrollWidth" | "clientWidth">): boolean {
  return el.scrollWidth - el.clientWidth - Math.abs(el.scrollLeft) > 2;
}

export function HScroller({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const update = useCallback(() => {
    const el = ref.current;
    if (el) setMore(measureMore(el));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [update]);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      tabIndex={0}
      data-more={more ? "" : undefined}
      data-testid="h-scroller"
      className="h-scroller -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      {children}
    </div>
  );
}
