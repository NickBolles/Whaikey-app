"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronRight, Disc3, GraduationCap, Search, Sparkles } from "lucide-react";
import { allLessons } from "@/lib/education";
import { useLearnProgress } from "@/lib/learn-progress";

const CHIP_ICONS = { ask: Sparkles, learn: GraduationCap, find: Search } as const;

/**
 * Ask · Learn · Find: a chip row that jumps to each section and follows the
 * scroll. Plain in-page anchors, so it works before hydration and with any
 * input; the bottom nav stays the only sticky bar on mobile (DESIGN.md rule
 * 10), and the chips sit at the top of the hub instead.
 */
export function DiscoverChips({ sections }: { sections: { id: string; label: string }[] }) {
  const [current, setCurrent] = useState(sections[0]?.id);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setCurrent(top.target.id);
      },
      { rootMargin: "0px 0px -60% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [sections]);

  return (
    <nav aria-label="Discover sections" className="border-b border-border px-3 py-2">
      <ul className="flex gap-1.5 py-1">
        {sections.map(({ id, label }) => {
          const Icon = CHIP_ICONS[id as keyof typeof CHIP_ICONS];
          const on = id === current;
          return (
            <li key={id}>
              <a
                href={`#${id}`}
                aria-current={on ? "true" : undefined}
                className={`tap-target inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm ${
                  on ? "btn-primary border-accent-deep font-semibold" : "border-border text-muted hover:text-foreground"
                }`}
              >
                {Icon && <Icon size={15} strokeWidth={1.8} aria-hidden />}
                {label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Today's lesson with a progress ring. Progress is device-local, so this is client-side. */
export function DiscoverLearn() {
  const { completed } = useLearnProgress();
  const lessons = allLessons();
  const done = lessons.filter((l) => completed.has(l.slug)).length;
  const next = lessons.find((l) => !completed.has(l.slug));
  const r = 22;
  const c = 2 * Math.PI * r;
  const frac = lessons.length ? done / lessons.length : 0;

  return (
    <>
      <Link
        href={next ? `/learn/${next.slug}` : "/learn"}
        className="card flex items-center gap-3 p-4 hover:brightness-110 transition-[filter]"
      >
        <svg width="52" height="52" viewBox="0 0 52 52" className="shrink-0" role="img" aria-label={`${done} of ${lessons.length} lessons done`}>
          <circle cx="26" cy="26" r={r} fill="none" stroke="var(--color-border)" strokeWidth="5" />
          <circle
            cx="26"
            cy="26"
            r={r}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(c * frac).toFixed(1)} ${c.toFixed(1)}`}
            transform="rotate(-90 26 26)"
          />
          <text x="26" y="30" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">
            {done}/{lessons.length}
          </text>
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-accent">{next ? `Today's lesson · ${next.minutes} min` : "Curriculum complete"}</span>
          <span className="block font-display text-lg font-semibold leading-snug">{next ? next.title : "Revisit any lesson"}</span>
          {next && <span className="block text-sm text-muted line-clamp-1">{next.teaser}</span>}
        </span>
        <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
      </Link>
      <Link href="/learn/flavors" className="card-flat flex min-h-11 items-center gap-3 px-4 py-2.5 hover:bg-surface-raised">
        <Disc3 size={18} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Flavor wheel</span>
          <span className="block text-xs text-muted">Eight families · where each comes from</span>
        </span>
        <ChevronRight size={16} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
      </Link>
      <Link href="/learn" className="self-start text-sm text-accent underline-offset-4 hover:underline tap-target">
        All lessons
      </Link>
    </>
  );
}

export const HINT_KEY = "caskfolk:discover-menu-hint";
const HINT_EVENT = "caskfolk:discover-menu-hint";

function readHintSeen(): string {
  try {
    return window.localStorage.getItem(HINT_KEY) ?? "";
  } catch {
    return "1"; // storage blocked: never nag
  }
}
function subscribeHint(cb: () => void) {
  window.addEventListener(HINT_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(HINT_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** One-time tip (per device) that Discover has a quick menu. */
export function DiscoverMenuHint() {
  const seen = useSyncExternalStore(subscribeHint, readHintSeen, () => "1");
  if (seen) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* storage blocked */
    }
    window.dispatchEvent(new Event(HINT_EVENT));
  };
  return (
    <div
      role="status"
      data-testid="discover-menu-hint"
      className="fixed bottom-20 right-3 z-40 max-w-[15rem] rounded-xl border border-border bg-surface-raised px-3 py-2 text-sm shadow-[3px_3px_0_rgba(0,0,0,0.3)]"
    >
      <p>Tip: hold Discover (or tap it again) for a quick menu.</p>
      <button type="button" onClick={dismiss} className="tap-target mt-1 text-sm font-semibold text-accent">
        Got it
      </button>
    </div>
  );
}
