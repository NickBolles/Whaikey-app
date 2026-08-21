import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Star } from "lucide-react";
import { getDb } from "@/db";
import { PASSPORT_FAMILIES, type PassportFamily } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { getOwnProfile } from "@/lib/social";
import { PASSPORT_TIER_SPECS, bottlesForTier, getPassportBadgeDetail, tierSpec } from "@/lib/passport";
import { PassportBadgeIcon } from "@/components/passport-badge";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ family: string; value: string }> };

function parseFamily(raw: string): PassportFamily | null {
  return (PASSPORT_FAMILIES as readonly string[]).includes(raw) ? (raw as PassportFamily) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { value } = await params;
  return { title: `Passport · ${decodeURIComponent(value)}`, robots: { index: false, follow: false } };
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = { month: "short", year: "numeric" };

/**
 * The owner's drill-down for one passport badge: the crest, where it stands
 * against the catalog, the tier history (dates stamped, never removed), and
 * every distinct bottle behind it. Pour counts and dates render here because
 * this page is only ever the signed-in user's own passport — nothing on it is
 * projected to anyone else (docs/SOCIAL.md §3.3).
 */
export default async function PassportBadgePage({ params }: Props) {
  const { family: rawFamily, value: rawValue } = await params;
  const family = parseFamily(rawFamily);
  if (!family) notFound();
  const value = decodeURIComponent(rawValue);

  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-6 px-6 text-center">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Passport</h1>
          <p className="text-muted mt-2 max-w-sm leading-relaxed">Sign in to see the bottles behind your badges.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const db = getDb();
  const [detail, ownProfile] = await Promise.all([
    getPassportBadgeDetail(db, user.id, family, value),
    getOwnProfile(db, user.id),
  ]);
  if (!detail) notFound();
  const { badge, bottles } = detail;
  const backHref = ownProfile ? `/u/${ownProfile.handle}` : "/";

  const heldSpec = tierSpec(badge.heldTier);
  const nextSpec = PASSPORT_TIER_SPECS.find((spec) => badge.metCount < bottlesForTier(spec, badge.catalogTotal));
  const pct = badge.catalogTotal > 0 ? Math.min(100, Math.round((100 * badge.metCount) / badge.catalogTotal)) : null;
  const achieved = PASSPORT_TIER_SPECS.filter((spec) => badge.achievedAt[spec.tier] != null);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 pb-24 pt-8">
      <Link href={backHref} className="text-muted hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors">
        <ArrowLeft size={18} strokeWidth={1.8} aria-hidden /> Profile
      </Link>

      <section className="card flex items-center gap-4 p-5">
        <PassportBadgeIcon family={badge.family} value={badge.value} tier={badge.heldTier} size={72} count={badge.metCount} />
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold leading-tight">{badge.label}</h1>
          <p className="mt-1 text-sm text-muted">
            {heldSpec ? `${heldSpec.name} ${heldSpec.numeral}` : "No tier yet"}
            {pct != null && (
              <>
                {" · "}
                <span className="text-accent">
                  {badge.metCount} of {badge.catalogTotal} catalog bottles · {pct}%
                </span>
              </>
            )}
          </p>
          {nextSpec && (
            <p className="mt-1 text-xs text-muted">
              {nextSpec.name} {nextSpec.numeral} at {bottlesForTier(nextSpec, badge.catalogTotal)} distinct bottles
            </p>
          )}
        </div>
      </section>

      {achieved.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="section-label">Tier history</h2>
          <ul className="flex flex-wrap gap-1.5">
            {achieved.map((spec) => (
              <li key={spec.tier} className="chip px-2.5 py-1 text-xs">
                {spec.name} {spec.numeral} ·{" "}
                {badge.achievedAt[spec.tier]!.toLocaleDateString("en-US", DATE_FORMAT)}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Stamped when reached and never removed — as the catalog grows your share can slip, the crest stays.
          </p>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="section-label">The bottles behind it</h2>
        <ul className="flex flex-col gap-2">
          {bottles.map((bottle) => (
            <li key={bottle.bottleId}>
              <Link href={`/bottles/${bottle.bottleId}`} className="card-flat block p-4 transition-colors hover:border-accent/40">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{bottle.name}</span>
                  {bottle.rating != null && (
                    <span className="flex shrink-0 items-center gap-1 text-sm text-accent">
                      <Star size={14} fill="currentColor" aria-hidden /> {bottle.rating.toFixed(1)}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted">
                  first tried {bottle.firstMetAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  {bottle.pourCount > 0 ? ` · ${bottle.pourCount} pour${bottle.pourCount === 1 ? "" : "s"} logged` : " · on your shelf"}
                </p>
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          Distinct bottles only — a repeat pour never moves a badge, and a 15&nbsp;ml sample counts in full.
        </p>
      </section>
    </div>
  );
}
