import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import { ONBOARDING_COOKIE, needsOnboarding } from "@/lib/onboarding";
import { getFriendFeed, getOwnProfile, listFollowing } from "@/lib/social";
import { HomeConcierge } from "@/components/home-concierge";
import { HomeHero } from "@/components/home-hero";
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

/** One state-aware line under the greeting; qualitative so it never repeats the hero's counts. */
function greetingSubtitle(bottleCount: number, pourCount: number): string {
  if (bottleCount === 0 && pourCount === 0) return "Let’s get the first bottle on your shelf.";
  if (pourCount === 0) return "Your shelf is stocked — the journal starts with a pour.";
  return "Your bar, your journal, and a concierge when you want one.";
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

  const [owned] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.userBottles)
    .where(and(eq(schema.userBottles.userId, user.id), eq(schema.userBottles.relationship, "own")));

  const [pourStats] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.pours)
    .where(eq(schema.pours.userId, user.id));

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
  }));

  const firstName = user.name?.split(" ")[0] || "there";
  const bottleCount = owned?.count ?? 0;
  const pourCount = pourStats?.count ?? 0;

  return (
    <div className="flex flex-col gap-7 px-4 pt-5">
      <header>
        <h1 className="font-display text-[2rem] font-semibold leading-tight">
          Welcome back, {firstName}
        </h1>
        <p className="mt-1 text-muted">{greetingSubtitle(bottleCount, pourCount)}</p>
      </header>

      <HomeHero bottleCount={bottleCount} pourCount={pourCount} />

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
              <li key={p.id}>
                <Link
                  href={`/bottles/${p.bottleId}`}
                  className="card-flat flex items-center justify-between gap-3 p-4 transition-colors hover:bg-surface-raised"
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
