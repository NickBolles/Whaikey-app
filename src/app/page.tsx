import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import { ONBOARDING_COOKIE, needsOnboarding } from "@/lib/onboarding";
import { getFriendFeed, getOwnProfile, listFollowing } from "@/lib/social";
import { getPalateMatches } from "@/lib/taste-twins";
import { appNow } from "@/lib/clock";
import { getDashboard } from "@/lib/dashboard";
import { Dashboard } from "@/components/dashboard";
import { HomeConcierge } from "@/components/home-concierge";
import { HomeHero } from "@/components/home-hero";
import { QuickPourButton } from "@/components/quick-pour-button";
import { RecommendationRail } from "@/components/recommendation-rail";
import { FriendsModule, type FriendFeedItem } from "@/components/friends-module";
import { ChevronRight, GraduationCap, Star } from "lucide-react";

export const dynamic = "force-dynamic";

function SignedOutHero() {
  return (
    <div className="flex min-h-[78dvh] flex-col items-center justify-center gap-7 px-6 text-center">
      <div aria-hidden className="text-6xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
        🥃
      </div>
      <div>
        <h1 className="font-display text-5xl font-semibold tracking-tight text-gradient-amber">
          Whaikey
        </h1>
        <p className="mx-auto mt-4 max-w-sm leading-relaxed text-muted">
          Track your bottles, log your pours, map your palate — and ask the AI concierge anything
          about whiskey or your own bar.
        </p>
      </div>
      <Link href="/sign-in" className="btn-primary px-10 py-3.5 text-base">
        Get started
      </Link>
      <p className="text-xs text-muted/70">Your notes stay yours. Sip responsibly.</p>
    </div>
  );
}

/**
 * Deterministic (no clock, no locale surprises) date label for journal rows,
 * so server-rendered output stays stable under the pinned-clock visual suite.
 */
function pourDateLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) return <SignedOutHero />;

  const db = getDb();

  // First-run handoff: the /welcome tour owns brand-new accounts. The cookie
  // (set by /welcome on finish or skip) short-circuits the DB check.
  const cookieStore = await cookies();
  if (!cookieStore.get(ONBOARDING_COOKIE) && (await needsOnboarding(db, user.id))) {
    redirect("/welcome");
  }

  // The dashboard's month-in-review also carries the shelf total and lifetime
  // pour count, so the hero reuses them instead of re-counting.
  const dashboard = await getDashboard(db, user.id, appNow());

  const recentPours = await db
    .select({
      id: schema.pours.id,
      rating: schema.pours.rating,
      createdAt: schema.pours.createdAt,
      bottleName: schema.bottles.name,
      bottleId: schema.bottles.id,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .where(eq(schema.pours.userId, user.id))
    .orderBy(desc(schema.pours.createdAt))
    .limit(3);

  // US-7: the "From your friends" Home module (docs/SOCIAL.md §7.3). A profile
  // and at least one accepted follow are prerequisites for the graph to have
  // anything to show — checked separately from the feed query so the empty
  // states can tell "no friends yet" apart from "friends, quiet week".
  const [ownProfile, following] = await Promise.all([
    getOwnProfile(db, user.id),
    listFollowing(db, user.id),
  ]);
  const hasProfile = Boolean(ownProfile?.socialEnabled);
  const hasFollows = following.some((f) => f.state === "accepted");
  const friendFeedRaw = hasFollows ? await getFriendFeed(db, user.id, { limit: 3 }) : [];
  // US-16: matches for exactly the authors on screen. Ranking the whole graph
  // and keeping a top slice would drop the chip from a recent note whenever
  // its author sat outside that slice — the feed picks by recency, not by
  // match, so the two orderings must not be conflated.
  const matchByUserId = await getPalateMatches(
    db,
    user.id,
    friendFeedRaw.map((f) => f.author.userId),
  );
  const friendFeedItems: FriendFeedItem[] = friendFeedRaw.map((f) => ({
    pourId: f.pourId,
    bottleId: f.bottleId,
    bottleName: f.bottleName,
    author: f.author,
    rating: f.rating,
    servingStyle: f.servingStyle,
    createdAt: f.createdAt.toISOString(),
    nose: f.nose,
    palate: f.palate,
    finish: f.finish,
    freeform: f.freeform,
    flavorTags: f.flavorTags,
    cheersCount: f.cheersCount,
    commentCount: f.commentCount,
    viewerTags: f.viewerTags,
    viewerBottleRelationship: f.viewerBottleRelationship,
    palateMatchPercent: matchByUserId.get(f.author.userId) ?? null,
  }));

  const bottleCount = dashboard.shelfTotal;
  const pourCount = dashboard.totalPours;

  return (
    <div className="flex flex-col gap-7 px-4 pt-5">
      {/* Home's upper half is the month in review — greyed skeleton and all,
          it renders for everyone; the skeleton is what motivates the first log. */}
      <Dashboard data={dashboard} userName={user.name} userImage={user.image} />

      <HomeHero bottleCount={bottleCount} pourCount={pourCount} />

      {/* Discovery pairs with tonight's pick: both answer "what's next?" —
          which is Home's job. My Bar stays about the bottles you own. */}
      {bottleCount > 0 && <RecommendationRail mode="discovery" title="For your palate" />}

      <FriendsModule items={friendFeedItems} hasProfile={hasProfile} hasFollows={hasFollows} />

      {recentPours.length > 0 && (
        <section aria-label="Your journal">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="section-label">Your journal</h2>
            <Link
              href="/history"
              className="tap-target text-sm text-muted transition-colors hover:text-foreground"
            >
              See all →
            </Link>
          </div>
          <ul className="flex flex-col gap-2.5">
            {recentPours.map((p) => (
              <li key={p.id} className="card-flat flex items-center gap-3 p-4">
                <Link
                  href={`/bottles/${p.bottleId}`}
                  className="flex min-w-0 flex-1 items-center justify-between gap-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.bottleName}</span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {pourDateLabel(p.createdAt)}
                    </span>
                  </span>
                  {p.rating != null && (
                    <span className="flex shrink-0 items-center gap-1.5 text-accent">
                      <Star size={14} fill="currentColor" aria-hidden />
                      <span className="stat-number text-lg leading-none">{p.rating.toFixed(1)}</span>
                    </span>
                  )}
                </Link>
                {/* One tap re-logs the same dram — zero notes, zero score. */}
                <QuickPourButton bottleId={p.bottleId} bottleName={p.bottleName} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="More from Whaikey" className="flex flex-col gap-2.5">
        <Link
          href="/learn"
          className="card-flat flex min-h-11 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-raised"
        >
          <GraduationCap size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm">
            Whiskey School — short lessons on styles, casks, and the flavor wheel.
          </span>
          <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
        </Link>
        <HomeConcierge aiConfigured={isAiConfigured()} />
      </section>
    </div>
  );
}
