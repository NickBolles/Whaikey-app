import Link from "next/link";
import { Star } from "lucide-react";
import { RatingSparkline } from "@/components/rating-sparkline";
import { SmallStars } from "@/components/small-stars";

/** One pour of this bottle, serialized for display (timestamp as ISO). */
export interface YourPourItem {
  id: string;
  rating: number | null;
  servingStyle: string | null;
  amountMl: number | null;
  createdAt: string;
  /** First line of the tasting note, already trimmed; null when unnoted. */
  snippet: string | null;
}

/** Recent pours shown inline; the journal carries the rest. */
const SHOWN_POURS = 3;
/** A trend needs at least this many rated pours before the sparkline draws. */
const SPARKLINE_MIN_RATED = 3;

/**
 * Dates are formatted in UTC on purpose: this section renders on the server,
 * and a viewer-timezone date here would disagree with the server-rendered
 * HTML on hydration. Day-level precision is all this list claims; exact local
 * times live in the journal.
 */
function pourDate(iso: string, withYear: boolean): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/**
 * The drinker's own history with this bottle: their average over rated pours
 * (the same mean the My Bar card shows), the range when pours disagreed, a
 * rating trend once there are enough rated pours to draw one, and the most
 * recent pours inline with a path to the full journal.
 */
export function YourPours({
  bottleId,
  pours,
}: {
  bottleId: string;
  /** ALL of the viewer's pours of this bottle, newest first. */
  pours: YourPourItem[];
}) {
  if (pours.length === 0) return null;

  const rated = pours.filter((p) => p.rating != null) as Array<YourPourItem & { rating: number }>;
  const avg = rated.length > 0 ? rated.reduce((sum, p) => sum + p.rating, 0) / rated.length : null;
  const min = rated.length > 0 ? Math.min(...rated.map((p) => p.rating)) : null;
  const max = rated.length > 0 ? Math.max(...rated.map((p) => p.rating)) : null;
  const hasRange = min != null && max != null && min < max;

  // Oldest → newest, so the sparkline reads left to right like a sentence.
  const trend = [...rated].reverse();
  const shown = pours.slice(0, SHOWN_POURS);
  // Years stay implied until the list itself spans more than one.
  const newestYear = new Date(pours[0].createdAt).getUTCFullYear();
  const spansYears = pours.some((p) => new Date(p.createdAt).getUTCFullYear() !== newestYear);

  return (
    <section aria-label="Your pours">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="section-label">Your pours</h2>
        {pours.length > SHOWN_POURS && (
          <Link
            href={`/history?bottleId=${bottleId}`}
            className="text-xs font-medium text-accent underline-offset-2 hover:underline"
          >
            All {pours.length} pours →
          </Link>
        )}
      </div>
      <div className="card flex flex-col gap-4 p-5">
        {avg != null ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="stat-number text-4xl leading-none">{avg.toFixed(1)}</span>
              <div className="flex flex-col gap-1.5">
                <SmallStars rating={avg} />
                <span className="text-[11px] uppercase tracking-[0.14em] text-muted">
                  your average
                </span>
              </div>
            </div>
            <div className="text-right text-sm text-muted">
              <div>
                {pours.length} pour{pours.length === 1 ? "" : "s"}
              </div>
              {hasRange && (
                <div className="mt-1 font-mono text-xs tabular-nums" aria-label={`Ratings ranged ${min.toFixed(1)} to ${max.toFixed(1)}`}>
                  {min.toFixed(1)}–{max.toFixed(1)}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">
            {pours.length} pour{pours.length === 1 ? "" : "s"} logged, none rated yet — rate the
            next one and your average starts here.
          </p>
        )}

        {trend.length >= SPARKLINE_MIN_RATED && (
          <div>
            <RatingSparkline ratings={trend.map((p) => p.rating)} />
            <div className="mt-1.5 flex items-baseline justify-between text-[10px] text-muted">
              <span>{pourDate(trend[0].createdAt, spansYears)}</span>
              <span className="uppercase tracking-[0.14em]">rating trend</span>
              <span>{pourDate(trend[trend.length - 1].createdAt, spansYears)}</span>
            </div>
          </div>
        )}

        <ul className="flex flex-col">
          {shown.map((pour) => (
            <li
              key={pour.id}
              className="flex flex-col gap-1 border-t border-border-subtle py-3 first:pt-0 first:border-t-0 last:pb-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium">
                  {pourDate(pour.createdAt, spansYears)}
                </span>
                {pour.rating != null && (
                  <span className="flex shrink-0 items-center gap-1.5 text-accent">
                    <Star size={12} strokeWidth={1.8} fill="currentColor" aria-hidden />
                    <span className="font-mono text-[13px] font-semibold leading-none">
                      {pour.rating.toFixed(1)}
                    </span>
                  </span>
                )}
              </div>
              {(pour.servingStyle || pour.amountMl != null) && (
                <div className="text-xs text-muted">
                  {[
                    pour.servingStyle
                      ? pour.servingStyle.charAt(0).toUpperCase() + pour.servingStyle.slice(1)
                      : null,
                    pour.amountMl != null ? `${pour.amountMl} ml` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
              {pour.snippet && (
                <p className="text-[13px] italic leading-relaxed text-muted">{pour.snippet}</p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
