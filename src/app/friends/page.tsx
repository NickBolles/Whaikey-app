import Link from "next/link";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { getOwnProfile, listBlocked, listFollowRequests, listFollowers, listFollowing } from "@/lib/social";
import { ProfileClaim } from "@/components/profile-claim";
import { FriendsClient } from "./friends-client";

export const dynamic = "force-dynamic";

/** A first-pass @handle from the account name — the user edits it before submitting. */
function suggestHandle(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 20);
  return base.length >= 3 ? base : `${base}whiskey`.slice(0, 20);
}

export default async function FriendsPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🤝
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Friends</h1>
          <p className="mt-2 max-w-sm text-muted">Sign in to follow friends and see who follows you.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const db = getDb();
  const profile = await getOwnProfile(db, user.id);

  if (!profile) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 pb-24 pt-8">
        <header>
          <h1 className="font-display text-[2rem] font-semibold leading-tight">Friends</h1>
          <p className="mt-1 text-sm text-muted">Claim a handle to start following people and being followed.</p>
        </header>
        <ProfileClaim suggestedHandle={suggestHandle(user.name)} />
      </div>
    );
  }

  const [requests, following, followers, blocked, phoneRow] = await Promise.all([
    listFollowRequests(db, user.id),
    listFollowing(db, user.id),
    listFollowers(db, user.id),
    listBlocked(db, user.id),
    // Not covered by getOwnProfile's projection — read the raw row for these
    // two columns; the owner reading their own phone state is fine.
    db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, user.id),
      columns: { phoneLast2: true, phoneDiscoverable: true },
    }),
  ]);

  const followerIds = new Set(followers.map((f) => f.userId));
  const followingWithMutual = following.map((f) => ({ ...f, mutual: f.state === "accepted" && followerIds.has(f.userId) }));

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 pb-24 pt-8">
      <header>
        <h1 className="font-display text-[2rem] font-semibold leading-tight">Friends</h1>
        <p className="mt-1 text-sm text-muted">@{profile.handle}</p>
      </header>
      <FriendsClient
        handle={profile.handle}
        phoneLast2={phoneRow?.phoneLast2 ?? null}
        phoneDiscoverable={phoneRow?.phoneDiscoverable ?? false}
        requests={requests}
        following={followingWithMutual}
        followers={followers}
        blocked={blocked}
      />
    </div>
  );
}
