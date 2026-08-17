"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { GlassWater, ScanLine, Search } from "lucide-react";
import { categoryLabel } from "@/components/category-chip";
import { getTonightPourContext } from "@/components/recommendation-rail";
import type { Recommendation } from "@/lib/recommend";

/**
 * The Home page's single accent moment: tonight's pick IS the primary action.
 * Stocked bars fetch the top "tonight" recommendation (same endpoint the rail
 * uses) and lead with "Log this pour" for that bottle; when no pick is
 * available the card falls back to the manual log/add actions, and empty bars
 * get "stock your bar" instead. Deliberately money-free — the hero is about
 * the pour, not the price.
 */
export function HomeHero({ bottleCount, pourCount }: { bottleCount: number; pourCount: number }) {
  if (bottleCount === 0) return <StockYourBar />;
  return <TonightHero bottleCount={bottleCount} pourCount={pourCount} />;
}

function StockYourBar() {
  return (
    <section aria-label="Stock your bar" className="card p-5">
      <h2 className="font-display text-xl font-semibold">Stock your bar</h2>
      <p className="mt-1 text-sm text-muted">
        Scan a label or search the catalog to put your first bottle on the shelf.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Link
          href="/scan"
          className="btn-primary flex min-h-11 items-center justify-center gap-2 px-3 py-3 text-sm"
        >
          <ScanLine size={18} strokeWidth={1.8} aria-hidden />
          Scan a bottle
        </Link>
        <Link
          href="/search"
          className="btn-secondary flex min-h-11 items-center justify-center gap-2 px-3 py-3 text-sm"
        >
          <Search size={18} strokeWidth={1.8} aria-hidden />
          Search
        </Link>
      </div>
      <Link
        href="/welcome"
        className="mt-2 inline-flex min-h-11 items-center text-sm text-muted transition-colors hover:text-foreground"
      >
        Take the tour
      </Link>
    </section>
  );
}

/**
 * Same hourly re-subscribe the recommendation rail uses: the server snapshot
 * is null (no clock on the server), so the time-aware heading only appears
 * after hydration and can never mismatch.
 */
function subscribeToLocalTime(onStoreChange: () => void) {
  let timeout: ReturnType<typeof setTimeout>;
  const scheduleNextHour = () => {
    const now = new Date();
    const msUntilNextHour =
      (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds();
    timeout = setTimeout(() => {
      onStoreChange();
      scheduleNextHour();
    }, msUntilNextHour);
  };
  scheduleNextHour();
  return () => clearTimeout(timeout);
}

/** Pre-hydration fallback heading; swapped for the local-time cue on the client. */
const NEUTRAL_CONTEXT = {
  title: "Tonight’s pour",
  detail: "A personal pick from your bar.",
};

function TonightHero({ bottleCount, pourCount }: { bottleCount: number; pourCount: number }) {
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState(false);
  const tonightContext = useSyncExternalStore(
    subscribeToLocalTime,
    () => getTonightPourContext(new Date().getHours()),
    () => null,
  );
  const context = tonightContext ?? NEUTRAL_CONTEXT;

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/recommendations?mode=tonight", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data = (await res.json()) as { recommendations: Recommendation[] };
        setRecs(data.recommendations ?? []);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(true);
      }
    })();
    return () => controller.abort();
  }, []);

  // Stable-height skeleton so the page doesn't jump while the pick loads.
  // The loading copy MUST stay "Finding bottles…" — the e2e settle() helper
  // waits for that exact text to detach before screenshotting.
  if (!error && recs === null) {
    return (
      <section aria-label={context.title} className="card flex min-h-[14rem] flex-col p-5">
        <h2 className="font-display text-xl font-semibold">{context.title}</h2>
        <p className="mt-1 text-sm text-muted">{context.detail}</p>
        <p role="status" className="py-2 text-sm text-muted">
          Finding bottles…
        </p>
      </section>
    );
  }

  const pick = recs?.[0];

  // No pick (nothing open yet, no rated pours, or the fetch failed): the
  // manual core loop is never blocked — fall back to log/add actions.
  if (!pick) {
    const bottles = `${bottleCount} bottle${bottleCount === 1 ? "" : "s"} on your shelf`;
    const pours = `${pourCount} pour${pourCount === 1 ? "" : "s"} logged`;
    return (
      <section aria-label="Your next pour" className="card p-5">
        <h2 className="font-display text-xl font-semibold">Your next pour</h2>
        <p className="mt-1 text-sm text-muted">
          {bottles} · {pours}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Link
            href="/pour"
            className="btn-primary flex min-h-11 items-center justify-center gap-2 px-3 py-3 text-sm"
          >
            <GlassWater size={18} strokeWidth={1.8} aria-hidden />
            Log a pour
          </Link>
          <Link
            href="/search"
            className="btn-secondary flex min-h-11 items-center justify-center gap-2 px-3 py-3 text-sm"
          >
            <Search size={18} strokeWidth={1.8} aria-hidden />
            Add a bottle
          </Link>
        </div>
      </section>
    );
  }

  const meta = [pick.distillery, categoryLabel(pick.category)].filter(Boolean).join(" · ");

  return (
    <section aria-label={context.title} className="card p-5">
      <h2 className="font-display text-xl font-semibold">{context.title}</h2>
      <p className="mt-1 text-sm text-muted">{context.detail}</p>

      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{pick.name}</p>
          {meta && <p className="mt-0.5 truncate text-xs text-muted">{meta}</p>}
        </div>
        {pick.matchPercent != null && (
          <span className="chip chip-active shrink-0 whitespace-nowrap px-2 py-0.5 text-[11px] font-medium text-accent">
            {pick.matchPercent}% match
          </span>
        )}
      </div>

      <p className="mt-2 text-sm leading-relaxed text-muted">{pick.reason}</p>

      <div className="mt-4 flex items-center gap-3">
        <Link
          href={`/pour?bottleId=${pick.bottleId}`}
          className="btn-primary flex min-h-11 flex-1 items-center justify-center gap-2 px-4 py-3 text-sm"
        >
          <GlassWater size={18} strokeWidth={1.8} aria-hidden />
          Log this pour
        </Link>
        <Link
          href="/pour"
          className="tap-target shrink-0 px-1 text-sm text-muted transition-colors hover:text-foreground"
        >
          Pick another
        </Link>
      </div>
    </section>
  );
}
