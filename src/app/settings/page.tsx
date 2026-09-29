import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Link2 } from "lucide-react";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userProfiles } from "@/db/schema";
import { getSessionUser } from "@/lib/session";
import { listPourShares } from "@/lib/pour-sharing";
import { getOwnProfile, getOwnSuspension, getSocialPrefs } from "@/lib/social";
import { listOwnModerationHolds } from "@/lib/moderation";
import { signInProviders } from "@/lib/account-data";
import { UserAvatar } from "@/components/user-avatar";
import { SignOutButton } from "@/app/age/sign-out-button";
import { DiscoveryPanel } from "@/app/friends/discovery-settings";
import { SharedLinksList } from "./shared-links-list";
import { PrivacyControls } from "./privacy-controls";
import { NotificationsCard } from "./notifications-card";
import { YourData } from "./your-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Settings", robots: { index: false, follow: false } };

const PROVIDER_NAMES: Record<string, string> = { google: "Google", apple: "Apple" };

/**
 * Settings (WP-11; STORYBOARD §3.7 "Settings (own)", review UX-4).
 *
 * Account · sign out · sharing · privacy (incl. how you're found) · rating
 * scale · units · notifications · export · delete, in that order — the
 * storyboard's list with `/sharing` folded in where its privacy card was.
 * Reached from the profile's Sharing · Settings row, and from `/sharing`,
 * which redirects here.
 */
export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          ⚙️
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Settings</h1>
          <p className="mt-2 max-w-sm text-muted">Sign in to manage your account, sharing and data.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const db = getDb();
  const [shares, profile, prefs, suspension, holds, providers, phone] = await Promise.all([
    listPourShares(db, user.id),
    getOwnProfile(db, user.id),
    getSocialPrefs(db, user.id),
    // A suspension reason stored where its subject cannot read it does not
    // keep the promise the Terms and /support both make (PLAN.md §9.4).
    getOwnSuspension(db, user.id),
    // And the same for anything moderation is holding down. The per-object
    // notices live on the pour concerned, which can become unreachable to the
    // very person the reason is addressed to; this page is theirs always.
    listOwnModerationHolds(db, user.id),
    signInProviders(db, user.id),
    // Not on getOwnProfile's projection, which is shaped for other viewers.
    db.query.userProfiles.findFirst({
      columns: { phoneLast2: true, phoneDiscoverable: true },
      where: eq(userProfiles.userId, user.id),
    }),
  ]);

  const providerLine = providers.length
    ? `Signed in with ${providers.map((p) => PROVIDER_NAMES[p] ?? p).join(" and ")}`
    : "Signed in";

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 px-4 pb-24 pt-8">
      {suspension && (
        <section role="note" className="card border-danger/50 p-4 flex flex-col gap-2 text-sm leading-relaxed">
          <p className="font-medium text-foreground">Your social surfaces are suspended.</p>
          <p className="text-muted">
            Your journal, your shelf and everything you have written are untouched and still yours —
            what is switched off is your profile, comments and anything shared with other people.
            Turning social back on is not something you can do while this stands.
          </p>
          {suspension.reason && <p className="italic text-muted">“{suspension.reason}”</p>}
          <p className="text-muted">
            If you think this is wrong,{" "}
            <Link href="/support" className="text-accent">
              send it back to us
            </Link>{" "}
            and a person will look again.
          </p>
        </section>
      )}

      {holds.length > 0 && (
        <section role="note" className="card border-danger/50 p-4 flex flex-col gap-3 text-sm leading-relaxed">
          <p className="font-medium text-foreground">
            {holds.length === 1 ? "A moderator hid something of yours." : `A moderator hid ${holds.length} things of yours.`}
          </p>
          <ul className="flex flex-col gap-2">
            {holds.map((hold) => (
              <li key={`${hold.subjectType}:${hold.subjectId}`} className="flex flex-col gap-0.5">
                <span className="text-muted">
                  {hold.subjectType === "pour" ? (
                    <>
                      A tasting note —{" "}
                      <Link href={`/notes/${hold.subjectId}`} className="text-accent">
                        see it
                      </Link>
                    </>
                  ) : (
                    <>A comment{hold.preview ? `: “${hold.preview}”` : ""}</>
                  )}
                </span>
                {hold.reason && <span className="italic text-muted">“{hold.reason}”</span>}
              </li>
            ))}
          </ul>
          <p className="text-muted">
            It is still yours and still here; what changed is that other people cannot see it, and you
            cannot put it back yourself. If you think that was wrong,{" "}
            <Link href="/support" className="text-accent">
              tell us
            </Link>
            .
          </p>
        </section>
      )}

      <header>
        <h1 className="font-display text-[2rem] font-semibold leading-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">Your account, what you share, and your data.</p>
      </header>

      {/* --- Account ------------------------------------------------------ */}
      <section aria-labelledby="account-heading" className="card flex flex-col gap-4 p-5">
        <p id="account-heading" className="section-label">
          Account
        </p>
        <div className="flex items-center gap-3">
          <UserAvatar name={user.name} image={user.image ?? null} size={48} />
          <div className="min-w-0">
            <p className="truncate font-medium">{user.name}</p>
            <p className="truncate text-sm text-muted">{user.email}</p>
            <p className="text-xs text-muted">{providerLine}</p>
          </div>
        </div>
        {profile && (
          <Link
            href={`/u/${profile.handle}`}
            className="flex min-h-11 items-center justify-between rounded-xl border border-border-subtle px-3 text-sm transition-colors hover:border-accent/40"
          >
            <span>
              Your profile <span className="text-muted">@{profile.handle}</span>
            </span>
            <ChevronRight size={18} strokeWidth={1.8} className="text-muted" aria-hidden />
          </Link>
        )}
        <SignOutButton className="btn-secondary tap-target min-h-11 w-full px-4 text-sm disabled:opacity-60" />
      </section>

      {/* --- Sharing (was /sharing) -------------------------------------- */}
      <section id="sharing" aria-labelledby="sharing-heading" className="flex scroll-mt-20 flex-col gap-3">
        <div>
          <p className="section-label">Sharing</p>
          <h2 id="sharing-heading" className="mt-1 font-display text-xl font-semibold">
            Shared links
          </h2>
          <p className="mt-1 text-sm text-muted">
            {shares.length > 0
              ? `${shares.length} active link${shares.length === 1 ? "" : "s"} · bearer links, revoke any time`
              : "Links you share from your journal show up here, revocable any time."}
          </p>
        </div>
        {shares.length === 0 ? (
          <div className="card-flat flex items-center gap-3 rounded-2xl p-4">
            <Link2 size={20} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
            <p className="flex-1 text-sm text-muted">No shared links yet.</p>
            <Link href="/history" className="text-sm text-accent">
              Journal →
            </Link>
          </div>
        ) : (
          <SharedLinksList
            shares={shares.map((s) => ({
              code: s.code,
              pourId: s.pourId,
              bottleId: s.bottleId,
              bottleName: s.bottleName,
              createdAt: s.createdAt.toISOString(),
            }))}
          />
        )}
      </section>

      {/* --- Privacy ------------------------------------------------------- */}
      <PrivacyControls
        hasProfile={Boolean(profile)}
        initialDefaultVisibility={prefs.defaultPourVisibility}
        initialAllowComments={prefs.allowComments}
        initialSocialEnabled={profile?.socialEnabled ?? false}
      />

      {profile && (
        <section aria-labelledby="found-heading" className="card flex flex-col gap-4 p-5">
          <div>
            <p className="section-label">Privacy</p>
            <h2 id="found-heading" className="mt-1 font-display text-xl font-semibold">
              How you&rsquo;re found
            </h2>
            <p className="mt-1 text-sm text-muted">
              {profile.discoverable
                ? `Your profile can be suggested to people, and anyone can look up @${profile.handle}.`
                : `You are never suggested; only someone who types @${profile.handle} exactly finds you.`}
            </p>
          </div>
          <DiscoveryPanel
            initialPhoneLast2={phone?.phoneLast2 ?? null}
            initialPhoneDiscoverable={phone?.phoneDiscoverable ?? false}
            showSettingsLink={false}
          />
        </section>
      )}

      {/* --- Preferences ----------------------------------------------------- */}
      <section aria-labelledby="prefs-heading" className="card flex flex-col gap-3 p-5">
        <p id="prefs-heading" className="section-label">
          Preferences
        </p>
        {/*
          Both are statements, not switches. The rating scale is decided
          (PLAN.md §12: half stars, stored as such; a 100-point mode is not
          planned), and pour sizes are millilitres everywhere the app shows
          one. A units switch belongs here the day the pour sheet and journal
          can read it; shipping it before then would be a control that changes
          nothing.
        */}
        <dl className="flex flex-col divide-y divide-border-subtle text-sm">
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt>Rating scale</dt>
            <dd className="text-right text-muted">Half stars, ½ to 5</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt>Pour sizes</dt>
            <dd className="text-right text-muted">Millilitres (ml)</dd>
          </div>
        </dl>
        <p className="text-xs text-muted">These are the only scale and unit Whaikey has today.</p>
      </section>

      <NotificationsCard />

      <YourData />

      {/* --- About (PLAN.md §9.8: the resources page lives in Settings) ----- */}
      <p className="text-xs text-muted leading-relaxed">
        <Link href="/responsible" className="text-accent font-medium">
          Drinking responsibly
        </Link>{" "}
        — what this app will and won&apos;t do, and where to find help.
        <br />
        <Link href="/terms" className="text-accent">
          Terms
        </Link>{" "}
        ·{" "}
        <Link href="/privacy" className="text-accent">
          Privacy
        </Link>{" "}
        ·{" "}
        <Link href="/support" className="text-accent">
          Support
        </Link>
      </p>
    </div>
  );
}
