import type { Metadata } from "next";
import Link from "next/link";
import { PolicyPage } from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms you agree to by using Whaikey.",
};

/**
 * Terms of use (PLAN.md §9.3; review §5.4 lists this as a launch blocker).
 *
 * Written from what the app actually does rather than from a template: every
 * clause here corresponds to something in the codebase, and where a thing is
 * not built the text says so instead of promising it. The parts that need a
 * lawyer and a company name are marked by the banner in `PolicyPage`, not
 * papered over.
 */
export default function TermsPage() {
  return (
    <PolicyPage title="Terms">
      <Section title="What Whaikey is">
        <p>
          A private tasting journal with optional social surfaces. You record what you drink, what
          you thought of it, and what you paid; you choose, per note, whether anyone else sees any
          of it. Nothing you write is public by default.
        </p>
      </Section>

      <Section title="You have to be old enough">
        <p>
          There is a legal minimum drinking age where you are, and Whaikey asks for your date of
          birth and your market once, at first use. Answering untruthfully to get in is a breach of
          these terms. If you are under that age, the account is held until you reach it — nothing
          is deleted, and you can come back.
        </p>
      </Section>

      <Section title="What you post, and what we may do about it">
        <p>
          You keep ownership of your notes, ratings and photos. By making something visible to
          other people — a public pour, a comment, a profile, a share link — you grant us the
          licence needed to store it and show it to the people you chose, for as long as you leave
          it visible.
        </p>
        <p>
          You are responsible for what you post. Content that is unlawful, abusive, or that
          impersonates somebody may be <strong className="text-foreground">hidden</strong> from the
          social surfaces, and the account behind it may be{" "}
          <strong className="text-foreground">suspended</strong> from them. Neither deletes your
          journal: a moderation action removes something from other people&apos;s view, not from
          your own records.
        </p>
        <p>
          Reports are worked in order, oldest first, with a target of 72 hours. Every action is
          recorded with the reason for it.
        </p>
      </Section>

      <Section title="Appeals">
        <p>
          If something of yours was hidden or your account was suspended, you will be told the
          reason. Reply through{" "}
          <Link href="/support" className="text-accent">
            support
          </Link>{" "}
          and a person will look at it again. A suspension is not permanent by default and is not
          something you can lift yourself — that is the point of it.
        </p>
      </Section>

      <Section title="The catalog, and bottles you add">
        <p>
          When the catalog is missing a bottle you can add it. It is yours to use immediately and
          stays visible to you alone until somebody has checked it; once it joins the shared
          catalog it stops being yours to edit, because everybody else is then relying on it.
        </p>
        <p>
          Prices, valuations and availability are estimates drawn from public sources. They are not
          offers, appraisals, or advice.
        </p>
      </Section>

      <Section title="The AI features">
        <p>
          The concierge, label reading and note extraction send the text or image you gave them,
          plus the relevant part of your own data, to a third-party model provider — OpenRouter or
          Anthropic depending on configuration — which processes it to answer. See the{" "}
          <Link href="/privacy" className="text-accent">
            privacy policy
          </Link>
          . The AI can be wrong; it is not a source of fact about a bottle, a price, or anything
          else, and it will not encourage you to drink.
        </p>
      </Section>

      <Section title="What we do not promise">
        <p>
          The service is provided as it is. We do not promise it will be available, that a catalog
          entry is accurate, or that a price is current. Keep your own copy of anything you cannot
          afford to lose — an export is coming and is not built yet, which is stated plainly here
          rather than assumed.
        </p>
      </Section>

      <Section title="Ending it">
        <p>
          You can stop using Whaikey at any time. Account deletion is not yet built (PLAN.md §9.2);
          until it is, ask through support and it will be done by hand. We may end an account that
          is being used to harm other people, and will say why.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          <strong className="text-foreground">There is no announcement mechanism yet.</strong> When
          these terms change, the effective date at the top changes with them — that date is the
          only notice this app currently gives, and checking it is the only way to know. Telling you
          in the app before a material change is an open commitment (PLAN.md §9.3), not a built one.
          This paragraph will say something better the day it is.
        </p>
      </Section>
    </PolicyPage>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}
