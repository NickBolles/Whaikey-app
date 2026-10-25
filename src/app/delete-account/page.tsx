import type { Metadata } from "next";
import Link from "next/link";
import { legalIdentity } from "@/lib/legal";
import { getSessionUser } from "@/lib/session";
import { DeleteAccount } from "@/app/settings/your-data";
import { DeletionRequestForm } from "./deletion-request-form";

export const metadata: Metadata = {
  title: "Delete your account",
  description: "How to delete your Whaikey account and its data, in the app or on the web.",
};

export const dynamic = "force-dynamic";

/**
 * Public account deletion (M3.6 / Track D6).
 *
 * Google Play requires a web page, linked from the store listing, where
 * someone can ask for their account to be deleted **without reinstalling the
 * app**. It has to name the app and the developer, say how, and say what is
 * deleted and what is kept.
 *
 * Signed in, this is the same one button Settings has — `DELETE /api/account`,
 * the same `ACCOUNT_DATA` transaction, nothing re-implemented. Signed out,
 * "sign in and delete" is the first answer, because it is instant and proves
 * ownership by itself. The request form is for whoever cannot sign in any more
 * (a lost Google account): it lands in the support queue, and an operator
 * deletes only after confirming from the account's own email address — there
 * is no way to prove ownership of an account from a form, and deleting
 * somebody's journal on an unverified request is the worse failure.
 *
 * Ungated (src/lib/age-gate.ts): leaving must never require answering the gate.
 */
export default async function DeleteAccountPage() {
  const user = await getSessionUser();
  const { entity, contactEmail } = legalIdentity();
  const developer = entity ?? "the Whaikey developer";

  return (
    <div className="px-4 py-8 max-w-2xl mx-auto w-full flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Delete your Whaikey account
        </h1>
        <p className="text-muted leading-relaxed">
          Whaikey is published by {developer}. You can delete your account and everything in it
          at any time — in the app, or here on the web without installing anything.
        </p>
      </header>

      <section className="flex flex-col gap-2" aria-labelledby="in-app-heading">
        <h2 id="in-app-heading" className="font-display text-lg font-semibold">
          In the app
        </h2>
        <ol className="list-decimal pl-5 text-sm text-muted leading-relaxed flex flex-col gap-1">
          <li>Open Whaikey and go to <strong className="text-foreground">Settings</strong>.</li>
          <li>
            Under <strong className="text-foreground">Your data</strong>, choose{" "}
            <strong className="text-foreground">Delete account…</strong>
          </li>
          <li>Type DELETE to confirm. The account is deleted at once and every device is signed out.</li>
        </ol>
        <p className="text-sm text-muted leading-relaxed">
          Want a copy first? The same screen downloads everything you wrote as JSON or CSV.
        </p>
      </section>

      <section className="card flex flex-col gap-3 p-5" aria-labelledby="web-heading">
        <h2 id="web-heading" className="font-display text-lg font-semibold">
          On the web
        </h2>
        {user ? (
          <>
            <p className="text-sm text-muted leading-relaxed">
              You are signed in as <strong className="text-foreground">{user.email}</strong>.
              Deleting is permanent, immediate and cannot be undone.
            </p>
            <DeleteAccount />
          </>
        ) : (
          <>
            <p className="text-sm text-muted leading-relaxed">
              Sign in with the Google or Apple account you use for Whaikey, and you will come
              straight back here to delete it.
            </p>
            <Link
              href="/sign-in?next=%2Fdelete-account"
              className="btn-primary tap-target inline-flex w-fit min-h-11 items-center px-4 text-sm"
            >
              Sign in to delete
            </Link>
            <div className="border-t border-border-subtle pt-4 flex flex-col gap-2">
              <h3 className="text-sm font-medium">Can&rsquo;t sign in any more?</h3>
              <p className="text-xs text-muted leading-relaxed">
                Send a request with the email address your account uses. We will write to that
                address to confirm it is yours, and delete the account once you reply — usually
                within 7 days, and never on an unconfirmed request.
                {contactEmail ? (
                  <>
                    {" "}
                    You can also email{" "}
                    <a href={`mailto:${contactEmail}`} className="text-accent">
                      {contactEmail}
                    </a>
                    .
                  </>
                ) : null}
              </p>
              <DeletionRequestForm />
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="what-heading">
        <h2 id="what-heading" className="font-display text-lg font-semibold">
          What is deleted, and what is kept
        </h2>
        <p className="text-sm text-muted leading-relaxed">
          <strong className="text-foreground">Deleted:</strong> your account and sign-ins, your
          shelf, pours, tasting notes, concierge conversations, passport, profile, follows,
          comments and cheers, share links, push registrations and support messages you sent
          signed in.
        </p>
        <p className="text-sm text-muted leading-relaxed">
          <strong className="text-foreground">Kept without your name:</strong> AI usage meter
          readings and share-link counts (deleted after 90 days), reports you filed, and bottles
          you added that are now in the shared catalog. Database backups expire on our host&rsquo;s
          schedule. The full list is in the{" "}
          <Link href="/privacy#getting-it-out" className="text-accent">
            privacy policy
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
