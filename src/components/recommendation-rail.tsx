"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { categoryLabel } from "@/components/category-chip";
import { PassportBadgeIcon } from "@/components/passport-badge";
import type { Recommendation } from "@/lib/recommend";
import { badgeProgressCaption, type BadgeProgress } from "@/lib/passport-progress";
import { originLabel } from "@/lib/origin";
import { Compass } from "lucide-react";
import { BottleArt } from "@/components/bottle-art";

export interface RecommendationRailProps {
  mode: "discovery" | "tonight";
  /** Serif section heading, e.g. "Discover" or "What to pour tonight". */
  title: string;
  /** A line under the heading (discovery: what the rail is for). */
  subtitle?: string;
}

interface EmptyCopy {
  emoji: string;
  headline: string;
  sub: string;
}

export interface TonightPourContext {
  title: string;
  detail: string;
}

const TONIGHT_CONTEXTS = {
  morning: {
    title: "For later today",
    detail: "Your bar’s considered pick, ready when the moment is right.",
  },
  afternoon: {
    title: "This afternoon’s selection",
    detail: "A personal pick from your bar, at your pace.",
  },
  evening: {
    title: "Tonight’s pour",
    detail: "A personal pick from your bar for the evening.",
  },
  lateEvening: {
    title: "Tonight’s selection",
    detail: "A personal pick from your bar for a quieter moment.",
  },
} as const satisfies Record<string, TonightPourContext>;

/** A restrained, local-time cue that keeps the recommendation moment personal. */
export function getTonightPourContext(hour: number): TonightPourContext {
  if (hour < 12) return TONIGHT_CONTEXTS.morning;
  if (hour < 17) return TONIGHT_CONTEXTS.afternoon;
  if (hour < 22) return TONIGHT_CONTEXTS.evening;
  return TONIGHT_CONTEXTS.lateEvening;
}

function subscribeToLocalTime(onStoreChange: () => void) {
  let timeout: ReturnType<typeof setTimeout>;
  const scheduleNextHour = () => {
    const now = new Date();
    const msUntilNextHour = (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1_000 - now.getMilliseconds();
    timeout = setTimeout(() => {
      onStoreChange();
      scheduleNextHour();
    }, msUntilNextHour);
  };
  scheduleNextHour();
  return () => clearTimeout(timeout);
}

const EMPTY_COPY: Record<RecommendationRailProps["mode"], EmptyCopy> = {
  discovery: {
    emoji: "🧭",
    headline: "Tag a few flavors and I’ll learn your taste.",
    sub: "Rate or tag what you try, and picks for somewhere new show up here.",
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
export function RecommendationRail({ mode, title, subtitle }: RecommendationRailProps) {
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState(false);
  const tonightContext = useSyncExternalStore(
    subscribeToLocalTime,
    () => (mode === "tonight" ? getTonightPourContext(new Date().getHours()) : null),
    () => null,
  );

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

  const heading = tonightContext?.title ?? title;

  return (
    <section aria-label={heading} className="flex flex-col gap-3">
      <div>
        <h2 className="section-label">{heading}</h2>
        {(tonightContext?.detail ?? subtitle) && <p className="mt-1 text-sm text-muted">{tonightContext?.detail ?? subtitle}</p>}
      </div>

      {error && (
        <p role="alert" className="text-sm text-muted">
          Couldn’t load recommendations right now.
        </p>
      )}

      {!error && recs === null && (
        <p role="status" className="text-sm text-muted py-2">Finding bottles…</p>
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

/**
 * The passport hook on a discovery card: the crest this bottle would earn (or
 * move toward) and how far off it is. The two lines answer the question the
 * match chip cannot — "where have I not been?" — and both halves are DISTINCT
 * things met, so nothing here can be advanced by pouring more (AGENTS.md
 * §product guardrails, docs/SOCIAL.md §3.2).
 */
function BadgeProgressRow({ progress }: { progress: BadgeProgress }) {
  const caption = badgeProgressCaption(progress);
  return (
    <div className="mt-auto flex items-center gap-2 border-t border-border-subtle pt-2.5">
      {/* Below the 36px banner threshold on purpose: at this size the crest is
          a cue beside the words, not a badge to read a numeral off. */}
      <PassportBadgeIcon
        family={progress.family}
        value={progress.value}
        tier={progress.targetTier}
        size={22}
        className="shrink-0"
      />
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-medium leading-tight text-foreground/85">
          {progress.label}
        </span>
        <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted">{caption}</span>
      </span>
    </div>
  );
}

function RecCard({ rec, mode }: { rec: Recommendation; mode: RecommendationRailProps["mode"] }) {
  const meta = [rec.distillery, categoryLabel(rec.category), originLabel(rec.region, rec.country)]
    .filter(Boolean)
    .join(" · ");
  const progress = rec.badgeProgress;
  const highlight = mode === "discovery" ? rec.highlight : null;
  // The match chip stays unless the highlight already says it.
  const showMatch = rec.matchPercent != null && highlight?.kind !== "palate-match";

  return (
    <div className="card snap-start shrink-0 w-64 flex flex-col p-4 gap-2" data-testid="rec-card">
      <Link
        href={`/bottles/${rec.bottleId}`}
        className="flex flex-col gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-xl"
      >
        {(highlight || showMatch) && (
          <div className="flex items-center justify-between gap-2">
            {highlight ? (
              <span data-testid="discover-highlight" className="chip chip-active inline-flex min-w-0 items-center gap-1 px-2 py-0.5 text-xs font-medium text-accent">
                <Compass size={12} strokeWidth={2} aria-hidden className="shrink-0" />
                <span className="truncate">{highlight.text}</span>
              </span>
            ) : (
              <span />
            )}
            {showMatch && (
              <span className="chip shrink-0 px-2 py-0.5 text-[11px] font-medium text-accent whitespace-nowrap">
                {rec.matchPercent}% match
              </span>
            )}
          </div>
        )}
        <div className="flex items-start gap-3">
          <BottleArt name={rec.name} category={rec.category} distillery={rec.distillery} region={rec.region} country={rec.country} height={64} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-medium text-foreground leading-snug line-clamp-2">{rec.name}</span>
            {meta && <span className="text-xs text-muted line-clamp-2">{meta}</span>}
            {rec.avgPrice != null && (
              <span className="stat-number text-base text-accent">${Math.round(rec.avgPrice)}</span>
            )}
          </div>
        </div>
        <p className="text-sm text-muted leading-relaxed">{rec.reason}</p>
      </Link>

      {progress && <BadgeProgressRow progress={progress} />}

      {mode === "tonight" && (
        <Link
          href={`/pour?bottleId=${rec.bottleId}`}
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
