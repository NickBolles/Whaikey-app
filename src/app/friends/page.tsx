import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { encodeFeedCursor, getFriendFeed, getOwnProfile, listFollowing } from "@/lib/social";
import { getPalateMatches } from "@/lib/taste-twins";
import { toFeedItemJson } from "@/lib/feed";
import { unreadCount } from "@/lib/notify";
import { SocialTabs } from "@/components/social/social-tabs";
import { SocialFeed } from "@/components/social/social-feed";

export const dynamic = "force-dynamic";

const PAGE = 20;

/**
 * The Friends tab is the feed (docs/SOCIAL.md D15; design board C1): people
 * controls one tap away under "People", the inbox bell in the header, then
 * friends' notes as rich cards. Sparse first — with no follows it leads with
 * the invite loop, never a blank list (SOCIAL §6.3).
 */
export default async function FriendsFeedPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(210,123,62,0.25)]">
          🤝
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Friends</h1>
          <p className="mt-2 max-w-sm text-muted">Sign in to follow friends and see their notes.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const db = getDb();
  const profile = await getOwnProfile(db, user.id);
  // Claiming a handle lives with the people controls.
  if (!profile) redirect("/friends/people");

  const [feed, following, unread] = await Promise.all([
    getFriendFeed(db, user.id, { limit: PAGE }),
    listFollowing(db, user.id),
    unreadCount(db, user.id),
  ]);
  const matches = await getPalateMatches(db, user.id, feed.map((f) => f.author.userId));
  const items = feed.map((f) => toFeedItemJson(f, matches));
  const last = feed[feed.length - 1];
  const nextCursor = feed.length === PAGE && last ? encodeFeedCursor({ createdAt: last.createdAt, pourId: last.pourId }) : null;
  const followsAnyone = following.some((f) => f.state === "accepted");

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-3 pb-24 pt-5">
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-[1.75rem] font-semibold leading-tight">Friends</h1>
        <SocialTabs unread={unread} />
      </header>

      {!followsAnyone ? (
        <div className="card flex flex-col items-center gap-3 p-5 text-center">
          <p className="font-display text-lg font-semibold">A dram is better shared</p>
          <p className="max-w-xs text-sm text-muted">
            Follow the people you taste with and their notes land here, beside yours — with a cheers and a
            comment one tap away.
          </p>
          <Link href="/friends/people" className="btn-secondary px-5 py-2.5 text-sm font-medium">
            Find friends
          </Link>
        </div>
      ) : items.length === 0 ? (
        <div className="card-flat flex flex-col gap-2 p-4">
          <p className="text-sm text-muted">
            Quiet here for now. When friends share a note it shows up in this feed — share one of your own and
            the conversation usually starts.
          </p>
          <Link href="/friends/people" className="text-sm text-accent">
            Find more friends →
          </Link>
        </div>
      ) : (
        <SocialFeed initialItems={items} initialCursor={nextCursor} />
      )}
    </div>
  );
}
