import type { Metadata } from "next";
import Link from "next/link";
import { PolicyPage } from "@/components/policy-page";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Terms",
  description: `The terms you agree to by using ${BRAND_NAME}.`,
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
      <Section title={`What ${BRAND_NAME} is`}>
        <p>
          A private tasting journal with optional social surfaces. You record what you drink, what
          you thought of it, and what you paid; you choose, per note, whether anyone else sees any
          of it. Nothing you write is public by default.
        </p>
      </Section>

      <Section title="You have to be old enough">
        <p>
          There is a legal minimum drinking age where you are, and {BRAND_NAME} asks for your date of
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
        {/* DRAFT — owner + legal review (docs/TOS_DATA_REUSE.md §3.4). */}
        <p>
          Put formally: you give us a non-exclusive, worldwide, royalty-free licence to host, copy,
          resize, display and transmit what you post, only to run {BRAND_NAME} and only to the
          audience you chose. We do not sell it, license it to anyone else, or use it to train AI
          models. It ends when you delete the thing or your account, apart from the report copy
          below and backups that age out on the schedule in the privacy policy.
        </p>
        <p>
          Two things are different because other people come to rely on them.{" "}
          <strong className="text-foreground">Facts you add to the shared catalog</strong> — a
          bottle&apos;s details, a barcode confirmation, a correction — stay in the catalog after
          you leave, without your name on them. And if you choose to submit a{" "}
          <strong className="text-foreground">photo for a bottle&apos;s catalog page</strong>, you
          let us show it to everyone who opens that bottle, credited to you unless you ask
          otherwise, for as long as it stays there; you can ask for it to be taken down. Only submit
          photos you took yourself or have the right to share.
        </p>
        <p>
          <strong className="text-foreground">One narrow exception, and we would rather name it
          than have you find it.</strong>{" "}
          If somebody reports something you made visible, we keep a copy of it as it was at the
          moment it was reported, and that copy outlives your taking it down. It exists so the
          complaint can be judged against what was actually posted rather than against a version
          edited afterwards, and so an appeal has something to be answered from. It is shown only
          to whoever works the report, never to other users, and it covers nothing you never made
          visible in the first place.
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

      {/* DRAFT — owner + legal review (docs/TOS_DATA_REUSE.md). Everything from here to
          "The AI features" is new and not yet approved. */}
      <Section title="Using the catalog — and what not to do with it">
        <p>
          Look things up, log what you drink, share what you think: that is what the catalog is for.
          What it is not for is being copied wholesale. Unless we have agreed otherwise in writing,
          you may not:
        </p>
        <ul className="list-disc pl-5 flex flex-col gap-1.5">
          <li>
            scrape, crawl or otherwise collect {BRAND_NAME} content by automated means — the
            exception is search engines following our{" "}
            <a href="/robots.txt" className="text-accent">
              robots.txt
            </a>
            ;
          </li>
          <li>
            bulk-download the catalog, flavour profiles, tasting notes, photos or other content, or
            call our APIs from anything other than the {BRAND_NAME} apps;
          </li>
          <li>
            use {BRAND_NAME} content to build or feed a competing database, catalog, app or
            dataset, or to train, fine-tune or evaluate an AI or machine-learning model;
          </li>
          <li>
            get around rate limits, access controls, the age gate or any other security measure, or
            hide who you are to do so;
          </li>
          <li>collect information about other people who use {BRAND_NAME}.</li>
        </ul>
        <p>
          Your own data is always yours to take: the export in Settings is the way to get it, and
          nothing here limits it. If you want something we have not offered — a feed, a dataset,
          a research project — ask through{" "}
          <Link href="/support" className="text-accent">
            support
          </Link>
          .
        </p>
      </Section>

      <Section title="Whose the catalog is">
        <p>
          The catalog as a whole — the selection of bottles, how they are matched and grouped, the
          flavour profiles, the barcode mappings and the editing behind them — is {BRAND_NAME}
          &apos;s work, and we claim whatever rights the law gives in a compilation and a database
          like it. Your own notes and photos are not part of that claim; they stay yours.
        </p>
        <p>
          Some of the catalog comes from public records and open data released under licences such
          as CC BY, the Open Government Licence and the Open Database Licence. Those licences, not
          these terms, govern that data: take it from its source and you may use it however its
          licence allows. The sources, their licences and the credits they require are on{" "}
          <Link href="/sources" className="text-accent">
            Sources and credits
          </Link>
          . Nothing in these terms restricts a right an open licence gives you.
        </p>
      </Section>

      <Section title="If something here is yours">
        <p>
          If you believe something shown in {BRAND_NAME} — a photo, a logo, a piece of text —
          infringes your copyright or trade mark, tell us through{" "}
          <Link href="/support" className="text-accent">
            support
          </Link>{" "}
          with: what the work is, where it appears in {BRAND_NAME}, how to reach you, and a
          statement that you are the rights holder (or act for them) and believe in good faith the
          use is not authorised. We will take it down while we look, tell whoever posted it, and
          put it back only if they show it is theirs to share. Accounts that repeatedly post other
          people&apos;s work will be closed.
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
          afford to lose — the export in Settings downloads everything you have written, free,
          whenever you want it.
        </p>
      </Section>

      <Section title="Ending it">
        <p>
          You can stop using {BRAND_NAME} at any time, and delete your account from Settings whenever
          you choose — at once, with no undo. What that removes and what it keeps is set out in the
          privacy policy. We may end an account that is being used to harm other people, and will
          say why.
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
