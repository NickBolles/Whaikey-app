import Link from "next/link";
import type { ReactElement } from "react";
import type { Passport, PassportBadge } from "@/lib/passport";
import { tierSpec } from "@/lib/passport";
import { PassportBadgeIcon } from "@/components/passport-badge";

/**
 * The profile's passport: one icon-only badge wall (docs/FEATURES.md §11).
 * Every badge the user holds sits in a single wrap, ordered coarse to fine —
 * countries, then regions, then styles — because the families read from their
 * silhouettes (shield / coin / cask-end) and splitting them into labelled rows
 * only broke the wall into three near-empty lines. Hover/focus raises a
 * tooltip naming the badge and its tier; on the owner's own profile each badge
 * links to its detail page. Distinct-bottle counts render for the owner only —
 * another viewer sees the crest, its tier and the label, never a number
 * (docs/SOCIAL.md §3.3).
 */

function badgeHref(badge: PassportBadge): string {
  return `/passport/${badge.family}/${encodeURIComponent(badge.value)}`;
}

export function passportBadgeTitle(badge: PassportBadge): string {
  const spec = tierSpec(badge.heldTier);
  return spec ? `${badge.label} — ${spec.name} ${spec.numeral}` : badge.label;
}

function BadgeTile({ badge, isSelf }: { badge: PassportBadge; isSelf: boolean }): ReactElement {
  const title = passportBadgeTitle(badge);
  const ariaLabel = isSelf
    ? `${title}, ${badge.metCount} of ${badge.catalogTotal} catalog bottles. Opens badge details.`
    : title;
  const icon = (
    // 48px: exactly the count-chip threshold, so the owner's tiles carry
    // their numbers while smaller renders (pour cards) stay clean crests.
    <PassportBadgeIcon
      family={badge.family}
      value={badge.value}
      tier={badge.heldTier}
      size={48}
      count={isSelf ? badge.metCount : undefined}
    />
  );
  // h-14: the crest is 48×56 (72:84 ratio), so the tile holds it without
  // clipping while the width keeps the 48px touch target (rule 8 + tap-target
  // is unnecessary at this size).
  const tileClass =
    "inline-flex h-14 w-12 items-center justify-center rounded-xl transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";
  const tooltip = (
    <span
      role="tooltip"
      className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-44 -translate-x-1/2 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-left opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
    >
      <span className="font-display block text-[13px] font-semibold leading-tight">{title}</span>
      {isSelf ? (
        <span className="mt-0.5 block text-[11px] text-accent">
          {badge.metCount} of {badge.catalogTotal} catalog bottles
        </span>
      ) : null}
      <span className="mt-0.5 block text-[11px] text-muted">
        {isSelf ? "Tap to see every bottle behind it." : "Distinct bottles met — never how much or how often."}
      </span>
    </span>
  );

  return (
    <li className="group relative">
      {isSelf ? (
        <Link href={badgeHref(badge)} aria-label={ariaLabel} className={tileClass}>
          {icon}
        </Link>
      ) : (
        // Focusable so keyboard and long-press users can raise the tooltip,
        // but deliberately not a control: another user's passport has no
        // drill-down (their bottle history is not ours to open).
        <span tabIndex={0} role="img" aria-label={ariaLabel} className={tileClass}>
          {icon}
        </span>
      )}
      {tooltip}
    </li>
  );
}

export function PassportBadgesSection({ passport, isSelf }: { passport: Passport; isSelf: boolean }): ReactElement | null {
  // Coarse to fine: a country is the badge nobody can miss (every bottle has
  // one), a style the one everybody shares. Within a family getPassport has
  // already ordered by tier, so the wall reads highest-earned first.
  const badges = [...passport.countries, ...passport.regions, ...passport.styles];
  if (badges.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Passport">
      <h2 className="section-label">Passport</h2>
      <ul className="flex flex-wrap gap-2.5">
        {badges.map((badge) => (
          <BadgeTile key={`${badge.family}:${badge.value}`} badge={badge} isSelf={isSelf} />
        ))}
      </ul>
    </section>
  );
}
