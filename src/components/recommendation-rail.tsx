"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { categoryLabel } from "@/components/category-chip";
import type { Recommendation } from "@/lib/recommend";

export interface RecommendationRailProps {
  mode: "discovery" | "tonight";
  /** Serif section heading, e.g. "Bottles for you" or "What to pour tonight". */
  title: string;
}

interface EmptyCopy {
  emoji: string;
  headline: string;
  sub: string;
}

const EMPTY_COPY: Record<RecommendationRailProps["mode"], EmptyCopy> = {
  discovery: {
    emoji: "🧭",
    headline: "Log a few pours and I’ll learn your taste.",
    sub: "Rate what you drink and personalized picks show up here.",
  },
  tonight: {
    emoji: "🥃",
    headline: "No open bottles yet — crack one open.",
    sub: "Mark a bottle in your bar as open and I’ll help you choose.",
  },
};

/**
 * Client rail of profile-similarity recommendations for the home page. Fetches
 * /api/recommendations on mount; renders a horizontally-scrollable row of
 * on-design cards. Works with no API key (reasons are deterministic server-side).
 */
export function RecommendationRail({ mode, title }: RecommendationRailProps) {
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/recommendations?mode=${mode}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const data = (await res.json()) as { recommendations: Recommendation[] };
        setRecs(data.recommendations ?? []);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(true);
      }
    })();
    return () => controller.abort();
  }, [mode]);

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <h2 className="section-label">{title}</h2>

      {error && (
        <p role="alert" className="text-sm text-muted">
          Couldn’t load recommendations right now.
        </p>
      )}

      {!error && recs === null && (
        <p className="text-sm text-muted py-2">Finding bottles…</p>
      )}

      {!error && recs !== null && recs.length === 0 && <EmptyState mode={mode} />}

      {!error && recs !== null && recs.length > 0 && (
        <div className="-mx-4 px-4 flex gap-3 overflow-x-auto pb-1 snap-x snap-mandatory">
          {recs.map((rec) => (
            <RecCard key={rec.bottleId} rec={rec} mode={mode} />
          ))}
        </div>
      )}
    </section>
  );
}

function RecCard({ rec, mode }: { rec: Recommendation; mode: RecommendationRailProps["mode"] }) {
  const meta = [rec.distillery, categoryLabel(rec.category), rec.region ?? null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="card snap-start shrink-0 w-64 flex flex-col p-4 gap-2">
      <Link
        href={`/bottles/${rec.bottleId}`}
        className="flex flex-col gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-xl"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium text-foreground leading-snug">{rec.name}</span>
          {rec.matchPercent != null && (
            <span className="chip chip-active shrink-0 px-2 py-0.5 text-[11px] font-medium text-accent whitespace-nowrap">
              {rec.matchPercent}% match
            </span>
          )}
        </div>
        {meta && <span className="text-xs text-muted truncate">{meta}</span>}
        {rec.avgPrice != null && (
          <span className="stat-number text-base text-accent">${Math.round(rec.avgPrice)}</span>
        )}
        <p className="text-sm text-muted leading-relaxed">{rec.reason}</p>
      </Link>

      {mode === "tonight" && (
        <Link
          href="/pour"
          className="mt-auto inline-flex items-center min-h-11 text-sm font-medium text-accent hover:text-foreground transition-colors"
        >
          Log a pour
        </Link>
      )}
    </div>
  );
}

function EmptyState({ mode }: { mode: RecommendationRailProps["mode"] }) {
  const copy = EMPTY_COPY[mode];
  return (
    <div className="card p-6 text-center flex flex-col items-center gap-1.5">
      <div aria-hidden className="text-3xl mb-1">
        {copy.emoji}
      </div>
      <p className="font-display text-base font-semibold">{copy.headline}</p>
      <p className="text-sm text-muted leading-relaxed max-w-xs">{copy.sub}</p>
    </div>
  );
}
