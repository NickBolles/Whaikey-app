import type { Metadata } from "next";
import Link from "next/link";
import { legalIdentity } from "@/lib/legal";
import { FeedbackForm } from "./feedback-form";

export const metadata: Metadata = {
  title: "Support",
  description: "Get help with Whaikey, or tell us what went wrong.",
};

export const dynamic = "force-dynamic";

/**
 * The support page (PLAN.md §9.7; a store submission needs a public support
 * URL, and the review lists "a support channel that is not a GitHub issue
 * form" among the missing areas).
 *
 * Reachable signed out, and ungated: somebody who cannot get past sign-in or
 * the age gate is exactly the person who needs to reach us.
 */
export default function SupportPage() {
  const { contactEmail } = legalIdentity();
  return (
    <div className="px-4 py-8 max-w-2xl mx-auto w-full flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Support</h1>
        <p className="text-muted leading-relaxed">
          Something broken, or a moderation decision you want looked at again — this reaches a
          person. A wrong detail on a bottle has its own form; see below.
        </p>
      </header>

      <FeedbackForm />

      <section className="flex flex-col gap-2">
        <h2 className="font-display text-lg font-semibold">Other ways</h2>
        <p className="text-sm text-muted leading-relaxed">
          {contactEmail ? (
            <>
              Email{" "}
              <a href={`mailto:${contactEmail}`} className="text-accent">
                {contactEmail}
              </a>{" "}
              if you would rather.{" "}
            </>
          ) : null}
          A wrong detail on a bottle goes somewhere else on purpose: the{" "}
          <a
            href="https://github.com/NickBolles/Whaikey-app/issues/new?template=whiskey-catalog-feedback.yml"
            className="text-accent"
            target="_blank"
            rel="noreferrer noopener"
          >
            catalog feedback form
          </a>{" "}
          feeds a source-backed review that checks the claim against published sources before
          anything changes. Sent here it would just be a message somebody has to re-file.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-display text-lg font-semibold">Appeals</h2>
        <p className="text-sm text-muted leading-relaxed">
          If a note of yours was hidden or your account was suspended from the social surfaces, you
          were told the reason. Send it back here and a person will look again — a suspension is
          not something you can lift yourself, which is why there has to be somewhere to ask. See
          the{" "}
          <Link href="/terms" className="text-accent">
            terms
          </Link>{" "}
          for what a suspension does and does not touch.
        </p>
      </section>

      <p className="text-xs text-muted/70">
        <Link href="/terms" className="text-accent">
          Terms
        </Link>{" "}
        ·{" "}
        <Link href="/privacy" className="text-accent">
          Privacy
        </Link>{" "}
        ·{" "}
        <Link href="/responsible" className="text-accent">
          Drinking responsibly
        </Link>
      </p>
    </div>
  );
}
