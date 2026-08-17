import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { getOwnProfile } from "@/lib/social";
import { WelcomeClient } from "./welcome-client";

export const dynamic = "force-dynamic";

/**
 * A first-pass @handle from the account name — the user edits it before
 * submitting. Mirrors /friends (src/app/friends/page.tsx).
 */
function suggestHandle(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 20);
  return base.length >= 3 ? base : `${base}whiskey`.slice(0, 20);
}

/**
 * First-run onboarding wizard (fully skippable — docs/SOCIAL.md §7.1 as
 * amended 2026-08). Signup itself stays a 90-second path; this page is the
 * optional guided tour after it.
 */
export default async function WelcomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in?next=/welcome");

  const db = getDb();
  const [profile, phoneRow] = await Promise.all([
    getOwnProfile(db, user.id),
    // phoneLast2/phoneDiscoverable aren't in the SocialProfile projection —
    // the owner reading their own phone state is fine (same as /friends).
    db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, user.id),
      columns: { phoneLast2: true, phoneDiscoverable: true },
    }),
  ]);

  return (
    <WelcomeClient
      accountName={user.name}
      suggestedHandle={suggestHandle(user.name)}
      initialProfile={profile ? { handle: profile.handle, displayName: profile.displayName } : null}
      initialPhoneLast2={phoneRow?.phoneLast2 ?? null}
      initialPhoneDiscoverable={phoneRow?.phoneDiscoverable ?? false}
    />
  );
}
