import Link from "next/link";
import { Link2 } from "lucide-react";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listPourShares } from "@/lib/pour-sharing";
import { getOwnProfile, getOwnSuspension, getSocialPrefs } from "@/lib/social";
import { listOwnModerationHolds } from "@/lib/moderation";
import { SharedLinksList } from "./shared-links-list";
import { PrivacyControls } from "./privacy-controls";

export const dynamic = "force-dynamic";

export default async function SharingPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5 px-6 text-center">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🔗
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Your shared links</h1>
          <p className="mt-2 max-w-sm text-muted">Sign in to see and manage the links you&apos;ve shared.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const db = getDb();
  const [shares, profile, prefs, suspension, holds] = await Promise.all([
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
  ]);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 px-4 pb-24 pt-8">
      {suspension && (
        <section
          role="note"
          className="card border-danger/50 p-4 flex flex-col gap-2 text-sm leading-relaxed"
        >
          <p className="font-medium text-foreground">
            Your social surfaces are suspended.
          </p>
          <p className="text-muted">
            Your journal, your shelf and everything you have written are untouched and still
            yours — what is switched off is your profile, comments and anything shared with other
            people. Turning social back on is not something you can do while this stands.
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
        <section
          role="note"
          className="card border-danger/50 p-4 flex flex-col gap-3 text-sm leading-relaxed"
        >
          <p className="font-medium text-foreground">
            {holds.length === 1
              ? "A moderator hid something of yours."
              : `A moderator hid ${holds.length} things of yours.`}
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
            It is still yours and still here; what changed is that other people cannot see it, and
            you cannot put it back yourself. If you think that was wrong,{" "}
            <Link href="/support" className="text-accent">
              tell us
            </Link>
            .
          </p>
        </section>
      )}

      <header>
        <h1 className="font-display text-[2rem] font-semibold leading-tight">Sharing</h1>
        <p className="mt-1 text-sm text-muted">
          {shares.length > 0
            ? `${shares.length} active link${shares.length === 1 ? "" : "s"} · bearer links, revoke any time`
            : "Shared links and your privacy defaults, in one place."}
        </p>
      </header>

      {shares.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-8 text-center">
          <Link2 size={28} strokeWidth={1.8} className="text-muted" aria-hidden />
          <div>
            <p className="font-display text-lg font-semibold">No shared links yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted">
              Share a tasting note from your journal, and it&apos;ll show up here — revocable any time.
            </p>
          </div>
          <Link href="/history" className="btn-secondary px-6 py-2.5 text-sm">
            Go to your journal
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

      <PrivacyControls
        hasProfile={Boolean(profile)}
        initialDefaultVisibility={prefs.defaultPourVisibility}
        initialAllowComments={prefs.allowComments}
        initialSocialEnabled={profile?.socialEnabled ?? false}
      />

      {/*
        PLAN.md §9.8 asks for the resources page to be linked from Settings.
        There is no settings screen yet (it lands with WP-18), and this is the
        nearest thing the app has — the page people already come to when they
        want to change how much of themselves is on show.
      */}
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
