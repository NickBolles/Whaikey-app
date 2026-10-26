import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PassportBadgeIcon } from "@/components/passport-badge";
import { PASSPORT_TIER_SPECS, bottlesForTier, tierSpec } from "@/lib/passport-tiers";
import type { Passport, PassportBadge } from "@/lib/passport";

/**
 * Home's "Badge earned" card (Ledger × Paper feed card types): the viewer's
 * own most recent passport badge, in the current badge art, as one of the
 * shapes Home's feed is made of alongside friends' tasting notes and ratings.
 *
 * Own data only — a friend's tiers are derived from pours they never shared,
 * so they stay off every feed (docs/SOCIAL.md: derived status comes from
 * shared data only). Counts are distinct bottles met, never pours.
 *
 * Deliberately date-free: a tier is stamped (dated) the first time its owner
 * opens their passport, so a "new" tier and the same tier once stamped render
 * the same card — the card is about what you hold, not about when you looked.
 */
export function pickLatestBadge(passport: Passport): PassportBadge | null {
  const all = [...passport.countries, ...passport.regions, ...passport.styles].filter((b) => b.heldTier >= 1);
  if (all.length === 0) return null;
  const stampedMax = (b: PassportBadge) => Math.max(0, ...Object.keys(b.achievedAt).map(Number));
  const isUnstamped = (b: PassportBadge) => b.currentTier > stampedMax(b);
  const latestAt = (b: PassportBadge) =>
    Math.max(0, ...Object.values(b.achievedAt).map((d) => (d ? new Date(d).getTime() : 0)));
  return (
    [...all].sort(
      (a, b) =>
        Number(isUnstamped(b)) - Number(isUnstamped(a)) ||
        // Unstamped tiers have no date yet; ranking them by date would let the
        // order depend on which ones happened to be opened first.
        (isUnstamped(a) ? 0 : latestAt(b) - latestAt(a)) ||
        b.heldTier - a.heldTier ||
        a.label.localeCompare(b.label),
    )[0] ?? null
  );
}

export function LatestBadgeCard({ badge }: { badge: PassportBadge }) {
  const spec = tierSpec(badge.heldTier);
  const next = PASSPORT_TIER_SPECS.find((s) => s.tier === badge.heldTier + 1) ?? null;
  const nextAt = next ? bottlesForTier(next, badge.catalogTotal) : null;
  const href = `/passport/${badge.family}/${encodeURIComponent(badge.value)}`;

  return (
    <section aria-label="Your latest badge">
      <h2 className="section-label mb-2">Lately</h2>
      <Link
        href={href}
        className="card-flat flex min-h-11 flex-col gap-2 p-3 transition-colors hover:bg-surface-raised"
        data-feed-card="badge"
      >
        <span className="kicker">Badge earned</span>
        <span className="flex items-center gap-3 rounded-lg border border-dashed border-rule bg-accent/[0.04] px-2.5 py-2">
          <PassportBadgeIcon family={badge.family} value={badge.value} tier={badge.heldTier} size={44} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-display text-[15px] font-semibold leading-snug">
              {badge.label}
              {spec && <span className="text-muted font-normal"> · {spec.name} {spec.numeral}</span>}
            </span>
            <span className="block text-xs text-muted">
              {badge.metCount} distinct {badge.metCount === 1 ? "bottle" : "bottles"} met
              {next && nextAt != null && nextAt > badge.metCount ? ` · ${next.name} at ${nextAt}` : ""}
            </span>
          </span>
          <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
        </span>
      </Link>
    </section>
  );
}
