import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import { ONBOARDING_COOKIE, needsOnboarding } from "@/lib/onboarding";
import { getFriendFeed, getOwnProfile, listFollowing } from "@/lib/social";
import { appNow } from "@/lib/clock";
import { getDashboard, hasMonthData } from "@/lib/dashboard";
import { Dashboard } from "@/components/dashboard";
import { HomeConcierge } from "@/components/home-concierge";
import { HomeHero } from "@/components/home-hero";
import { RecommendationRail } from "@/components/recommendation-rail";
import { pickLatestBadge } from "@/components/latest-badge-card";
import { HomeLately, type HomeLatelyProps } from "@/components/home-lately";
import { PASSPORT_TIER_SPECS, bottlesForTier, tierSpec } from "@/lib/passport-tiers";
import { getPassport } from "@/lib/passport";
import { EMPTY_GATHERINGS, getGatherings } from "@/lib/gather";
import { GatherModule, NextOutingCard } from "@/components/gather-module";
import { HomeStartHere, pickStartActions } from "@/components/home-start-here";
import { withFallback } from "@/lib/settle";
import { ChevronRight, GraduationCap } from "lucide-react";
import { MarketingLanding } from "@/components/marketing-landing";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) return <MarketingLanding />;

  const db = getDb();
  const cookieStore = await cookies();

  // One round of independent reads instead of a serial waterfall (review
  // REL-6.3): the onboarding check, the month in review, the last pours and
  // the social graph all ask the database separate questions.
  //
  // First-run handoff: the /welcome tour owns brand-new accounts. The cookie
  // (set by /welcome on finish or skip) short-circuits the DB check. Running
  // the check alongside the rest costs a brand-new account one set of reads
  // it will not see, once; waiting on it first cost everyone else a round
  // trip on every visit.
  //
  // The dashboard's month-in-review also carries the shelf total and lifetime
  // pour count, so the hero reuses them instead of re-counting.
  //
  // US-7: the "From your friends" Home module (docs/SOCIAL.md §7.3). A profile
  // and at least one accepted follow are prerequisites for the graph to have
  // anything to show — checked separately from the feed query so the empty
  // states can tell "no friends yet" apart from "friends, quiet week". The
  // feed itself gates on accepted follows too (it returns nothing without
  // one), so it rides the same round rather than waiting on `following`.
  // The viewer's own passport feeds Home's "Badge earned" card (read only:
  // stamping a tier stays the job of opening the passport itself).
  //
  // Only the onboarding check and the month in review are load-bearing; every
  // other widget goes through `withFallback`, so one slow or failing read
  // renders that widget empty instead of holding the whole page (2026-10-27:
  // a stuck read here kept signed-in Home spinning to the 300 s limit).
  const [onboarding, dashboard, recentPours, ownProfile, following, friendFeed, passport, gatherings] = await Promise.all([
    cookieStore.get(ONBOARDING_COOKIE) ? false : needsOnboarding(db, user.id),
    getDashboard(db, user.id, appNow()),
    withFallback(db
      .select({
        id: schema.pours.id,
        rating: schema.pours.rating,
        createdAt: schema.pours.createdAt,
        bottleName: schema.bottles.name,
        bottleId: schema.bottles.id,
        bottleCategory: schema.bottles.category,
        bottleRegion: schema.bottles.region,
        bottleCountry: schema.bottles.country,
        bottleImageUrl: schema.bottles.imageUrl,
      })
      .from(schema.pours)
      .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
      .where(eq(schema.pours.userId, user.id))
      .orderBy(desc(schema.pours.createdAt))
      .limit(8), [], "home:recent-pours"),
    withFallback(getOwnProfile(db, user.id), null, "home:own-profile"),
    withFallback(listFollowing(db, user.id), [], "home:following"),
    withFallback(getFriendFeed(db, user.id, { limit: 20 }), [], "home:friend-feed"),
    withFallback(getPassport(db, user.id), null, "home:passport"),
    withFallback(getGatherings(db, user.id, appNow()), EMPTY_GATHERINGS, "home:gatherings"),
  ]);
  if (onboarding) redirect("/welcome");

  const hasProfile = Boolean(ownProfile?.socialEnabled);
  const hasFollows = following.some((f) => f.state === "accepted");
  const friendFeedRaw = hasFollows ? friendFeed : [];
  // "Lately" (owner feedback 2026-11-02): one compact feed. Friend rows come
  // only from getFriendFeed (visibility tier, blocks, suspensions applied
  // there); the feed assembly re-checks the tier. Badges are your own only.
  const friendItems: HomeLatelyProps["friendItems"] = friendFeedRaw.map((f) => ({
    pourId: f.pourId,
    bottleId: f.bottleId,
    bottleName: f.bottleName,
    rating: f.rating,
    createdAt: f.createdAt.toISOString(),
    visibility: f.visibility,
    author: { userId: f.author.userId, handle: f.author.handle, displayName: f.author.displayName, avatarUrl: f.author.avatarUrl },
  }));
  const ownPours: HomeLatelyProps["pours"] = recentPours.map((p) => ({
    id: p.id,
    bottleId: p.bottleId,
    bottleName: p.bottleName,
    rating: p.rating,
    createdAt: p.createdAt.toISOString(),
    bottleCategory: p.bottleCategory,
    bottleRegion: p.bottleRegion,
    bottleCountry: p.bottleCountry,
    bottleImageUrl: p.bottleImageUrl,
  }));

  const latestBadge = passport ? pickLatestBadge(passport) : null;
  const badgeRow: HomeLatelyProps["badge"] = latestBadge
    ? (() => {
        const spec = tierSpec(latestBadge.heldTier);
        const next = PASSPORT_TIER_SPECS.find((t) => t.tier === latestBadge.heldTier + 1) ?? null;
        const nextAt = next ? bottlesForTier(next, latestBadge.catalogTotal) : null;
        return {
          label: latestBadge.label,
          tierLabel: spec ? `${spec.name} ${spec.numeral}` : null,
          // Distinct bottles met — never pours.
          detail: `${latestBadge.metCount} distinct ${latestBadge.metCount === 1 ? "bottle" : "bottles"} met${next && nextAt != null && nextAt > latestBadge.metCount ? ` · ${next.name} at ${nextAt}` : ""}`,
          href: `/passport/${latestBadge.family}/${encodeURIComponent(latestBadge.value)}`,
          family: latestBadge.family,
          value: latestBadge.value,
          tier: latestBadge.heldTier,
        };
      })()
    : null;
  const bottleCount = dashboard.shelfTotal;
  const pourCount = dashboard.totalPours;
  const monthEmpty = !hasMonthData(dashboard);
  const startActions = pickStartActions({
    bottleCount,
    hasTastedEver: pourCount > 0,
    hasNextOuting: gatherings.nextOuting != null,
  });

  return (
    <div className="flex flex-col gap-7 px-4 pt-5">
      {/* Home order (owner feedback 2026-10-29, supersedes 2026-10-26's
          "concierge and School first"): the month first, then what's next,
          then suggestions, then the people side; Ask and School stay
          reachable as a compact row at the bottom. */}
      <Dashboard data={dashboard} userName={user.name} userImage={user.image} />

      {/* A planned outing lives in "Get together" (owner feedback
          2026-11-02); with none planned, the plan-one invitation keeps its
          place here exactly as before. */}
      {monthEmpty ? (
        <HomeStartHere actions={startActions} />
      ) : (
        !gatherings.nextOuting && (
          <section aria-label="What's next" className="flex flex-col gap-2.5">
            <h2 className="section-label">What&rsquo;s next</h2>
            <NextOutingCard data={gatherings} />
          </section>
        )
      )}

      <section aria-label="Suggestions" className="flex flex-col gap-4">
        <h2 className="section-label">Suggestions</h2>
        <HomeHero bottleCount={bottleCount} pourCount={pourCount} />
        {/* Discovery pairs with tonight's pick: both answer "what's next?". */}
        {bottleCount > 0 && (
          <RecommendationRail
            mode="discovery"
            title="Try something new"
            subtitle="New bottles that fit what you rate highly."
          />
        )}
      </section>

      <GatherModule data={gatherings} showOuting={gatherings.nextOuting != null} />

      <HomeLately
        viewerId={user.id}
        pours={ownPours}
        badge={badgeRow}
        friendItems={friendItems}
        hasProfile={hasProfile}
        hasFollows={hasFollows}
      />

      {/* Ask and School: still one tap away, no longer the lead. */}
      <section aria-label="Ask and learn" className="flex flex-col gap-2.5 pb-2">
        {isAiConfigured() && <HomeConcierge aiConfigured />}
        <Link
          href="/learn"
          className="card-flat flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-raised"
        >
          <GraduationCap size={18} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1 text-sm">
            Whiskey School <span className="text-muted">· styles, casks, the flavor wheel</span>
          </span>
          <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
        </Link>
      </section>
    </div>
  );
}
