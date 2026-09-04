import type { Metadata } from "next";
import Link from "next/link";
import { PolicyPage } from "@/components/policy-page";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Whaikey stores, who can see it, and how long it is kept.",
};

/**
 * Privacy policy (PLAN.md §9.3, §9.2; review §5.4).
 *
 * Written against the schema rather than from a template — every claim below
 * is checkable in `src/db/schema.ts` — and where something is promised
 * elsewhere but not built (export, deletion) it says so instead of describing
 * a control nobody has.
 */
export default function PrivacyPage() {
  return (
    <PolicyPage title="Privacy">
      <Section title="The short version">
        <p>
          Your notes and your shelf are private by default. Nothing becomes visible to another
          person because of something we did — only because you chose it, per object, and you can
          take it back. What you paid for a bottle never appears in anything anyone else can see.
        </p>
      </Section>

      <Section title="What we store">
        <ul className="list-disc pl-5 flex flex-col gap-1.5">
          <li>
            <strong className="text-foreground">Your account</strong> — the name, email address and
            avatar your sign-in provider gives us. There is no password: sign-in is Google or Apple
            only, so we never see one. Signing in also leaves the tokens the provider issues for it,
            encrypted at rest. They exist because sign-in works that way; Whaikey never uses them to
            read anything from Google or Apple, and they are deleted with the account.
          </li>
          <li>
            <strong className="text-foreground">Your sessions</strong> — for each device you are
            signed in on, a session token plus the IP address and browser your sign-in came from.
            They are what keep you signed in and what would show an account being used from
            somewhere it should not be. They go when the session expires or you sign out, and with
            the account.
          </li>
          <li>
            <strong className="text-foreground">Your journal</strong> — pours, ratings, tasting
            notes, flavour tags, the bottles on your shelf, and what you paid.
          </li>
          <li>
            <strong className="text-foreground">Your concierge conversations</strong> — every
            question you ask the AI and every answer it gives, kept so a conversation can be
            reopened where you left it. Stored with each answer is what the concierge looked up in
            your own data to write it, so a message log can contain slices of your journal as well
            as what you typed. There is no way to delete a single conversation yet; they go with
            the account.
          </li>
          <li>
            <strong className="text-foreground">Your age answer</strong> — the date of birth and
            market you gave the gate, once, and whether it met the minimum.
          </li>
          <li>
            <strong className="text-foreground">Social data, if you use it</strong> — your handle,
            profile, who you follow, comments, and any share links you create.
          </li>
          <li>
            <strong className="text-foreground">A phone number, only if you offer one</strong> — and
            never the number itself. We keep a keyed hash for exact-match lookup and the last two
            digits so you can recognise which number you gave. It cannot be reversed into a number.
          </li>
          <li>
            <strong className="text-foreground">Device push tokens</strong>, if you turn
            notifications on, so we can send to that device and stop when you sign out.
          </li>
          <li>
            <strong className="text-foreground">Anything you send us through support</strong> — the
            message itself, the contact address you offer with it, and which platform and app
            version you were on. It is kept so a person can act on it, which means anything you put
            in a message — including an appeal or a deletion request — is stored with it. Send only
            what you need us to know. If you were signed in, your account is attached; if you were
            not, only what you typed is.
          </li>
        </ul>
      </Section>

      <Section title="Who can see it">
        <p>
          Each pour carries its own visibility, set by you and never raised by us. Community numbers
          — a bottle&apos;s average rating, its flavour consensus — are built only from pours whose
          owners published them, and are withheld entirely until at least three distinct people are
          behind them, so a small number can never be read back to one person.
        </p>
        <p>
          A share link is a bearer credential: anyone holding the URL can open that note until you
          revoke it, which you can do at any time from{" "}
          <Link href="/sharing" className="text-accent">
            Sharing
          </Link>
          .
        </p>
      </Section>

      <Section title="Where it goes outside Whaikey">
        <ul className="list-disc pl-5 flex flex-col gap-1.5">
          <li>
            <strong className="text-foreground">The AI provider</strong> — OpenRouter or Anthropic,
            depending on configuration. When you use the concierge, scan a label, or have a note
            extracted, the relevant text or image and the relevant part of your own data are sent
            to be processed. Only what that request needs is sent.
          </li>
          <li>
            <strong className="text-foreground">Hosting and the database</strong> — the servers
            that run the app and store the rows above.
          </li>
          <li>
            <strong className="text-foreground">The push services</strong> — Apple and Google, if
            you enable notifications.
          </li>
        </ul>
        <p>We do not sell your data, and there is no advertising in Whaikey.</p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Your journal is kept until you delete it or the account. Short-lived things are swept:
          native sign-in codes are deleted the moment they are used and swept when they expire,
          rate-limit counters are dropped after a couple of days, and phone lookups are pruned.
        </p>
        <p>
          Concierge conversations are kept for the life of the account. Nothing prunes them and
          there is no per-conversation delete, so treat what you type there the way you would treat
          a note you are keeping: it stays until the account goes.
        </p>
        <p>
          Support messages and moderation records are the exception, and we would rather say so
          than imply otherwise: they are kept indefinitely today. A moderation record is what an
          appeal gets answered from, so it outlives the decision on purpose. A support message has
          no such reason — it is kept only because nothing prunes it yet. Ask through{" "}
          <Link href="/support" className="text-accent">
            support
          </Link>{" "}
          and we will delete yours.
        </p>
      </Section>

      <Section title="Getting it out, and getting rid of it">
        <p>
          <strong className="text-foreground">Not built yet, and we will not pretend otherwise.</strong>{" "}
          A one-tap export of everything you have written, and a real account deletion, are both
          committed to (PLAN.md §9.2) and neither has shipped. In the meantime, ask through{" "}
          <Link href="/support" className="text-accent">
            support
          </Link>{" "}
          and both will be done by hand. This page will be updated the day they exist.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Whaikey is not for anyone under the legal drinking age where they are, and the gate at
          first use is how we ask. An account that answers below the minimum is held, not used.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          <strong className="text-foreground">There is no announcement mechanism yet.</strong> When
          this text changes, the effective date at the top changes with it — that date is the only
          notice this app currently gives, and checking it is the only way to know. An in-app notice
          before a material change is an open commitment (PLAN.md §9.3), not a built one. This
          paragraph will say something better the day it is.
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
