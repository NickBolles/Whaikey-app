import type { Metadata } from "next";
import Link from "next/link";
import { X } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Drinking responsibly",
  description: `Where to find help, and what ${BRAND_NAME} will and won't do.`,
};

/**
 * The responsible-drinking resources page (PLAN.md §9.8, review PLAN-A7).
 *
 * Two jobs. It says plainly what the product will and will not do, because a
 * stance that lives only in a repo's guidelines is a stance nobody can hold us
 * to. And it lists real places to get help — named organisations at their own
 * addresses, with no numbers invented and no claims made about them beyond
 * what they say about themselves.
 */
export default function ResponsiblePage() {
  return (
    <div className="px-4 py-8 max-w-2xl mx-auto w-full flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Drinking responsibly
        </h1>
        <p className="text-muted leading-relaxed">
          {BRAND_NAME} is a tasting journal. It is built to help you notice what you like — not to
          help you drink more of it.
        </p>
      </header>

      {/* Owner feedback 2026-10-26: "a good spot for introducing koinonia".
          The why comes before the won't-do list: the table is the point. */}
      <section aria-labelledby="koinonia" className="flex flex-col gap-3">
        <p className="kicker text-editorial">Koinonia · κοινωνία</p>
        <h2 id="koinonia" className="font-display text-xl font-semibold">
          The company is the point
        </h2>
        <p className="text-sm text-muted leading-relaxed">
          Koinonia is an old Greek word for fellowship — the things people hold in common when they
          share a table. It is the idea {BRAND_NAME} is built around: a bottle is a reason to pull up a
          chair, and the conversation around it is what is worth remembering. That is why everything
          social here compares notes and palates, and nothing counts how much anyone poured.
        </p>
      </section>

      <section aria-labelledby="wont-do" className="card p-3 flex flex-col gap-3">
        <h2 id="wont-do" className="font-display text-xl font-semibold">
          What this app won&apos;t do
        </h2>
        <ul className="flex flex-col gap-3">
          <WontDo title={<>No streaks, and no &ldquo;you haven&apos;t poured in a while&rdquo;.</>}>
            Nothing here rewards drinking often, and nothing nudges you to pour.
          </WontDo>
          <WontDo title="No volume, proof or time-of-day badges.">
            The passport counts distinct things you have met — regions, distilleries, cask types — so
            a 15 ml sample of something new counts the same as a bottle, and a second pour of the same
            bottle counts for nothing.
          </WontDo>
          <WontDo title="No leaderboards for how much anyone drinks.">
            Friends&apos; surfaces compare notes and palates, never quantities.
          </WontDo>
          <WontDo title="The AI never encourages drinking.">
            It never invents a price, a rating, or a claim about a bottle either.
          </WontDo>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">What a pour actually is</h2>
        <p className="text-sm text-muted leading-relaxed">
          {BRAND_NAME}&apos;s default pour is 45 ml. At 45% ABV that is about 20 ml of pure alcohol;
          at cask strength, closer to 30 ml. For reference, a US standard drink is defined as
          14 g of pure alcohol, which is a little under 18 ml. Whiskey served neat is easy to
          under-count precisely because the glass looks empty long before a pint would.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">If you want to talk to someone</h2>
        <p className="text-sm text-muted leading-relaxed">
          These are independent organisations, not us, and not an endorsement of one over
          another. Availability and coverage are theirs to describe, so follow the link.
        </p>
        <ul className="flex flex-col gap-2">
          <Resource
            href="https://www.samhsa.gov/find-help/national-helpline"
            name="SAMHSA National Helpline (US)"
            note="Free and confidential treatment referral and information, 1-800-662-4357."
          />
          <Resource
            href="https://www.rethinkingdrinking.niaaa.nih.gov/"
            name="Rethinking Drinking (NIAAA, US)"
            note="Self-assessment tools and plain explanations of what the numbers mean."
          />
          <Resource
            href="https://www.drinkaware.co.uk/"
            name="Drinkaware (UK)"
            note="Guidance, self-assessment, and a drinking-support line."
          />
          <Resource
            href="https://www.aa.org/"
            name="Alcoholics Anonymous"
            note="Meeting finders worldwide, in person and online."
          />
          <Resource
            href="https://www.who.int/health-topics/alcohol"
            name="World Health Organization"
            note="Global guidance, and links onward to national services."
          />
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">Your data</h2>
        <p className="text-sm text-muted leading-relaxed">
          Nothing you log is visible to anyone until you set up a social profile. Once you have
          one, each pour uses your default audience — Friends (people you follow who follow you
          back) for new accounts — and you can switch it, per pour or as the default, to Only me. Your shelf stays yours, and what you paid
          never appears anywhere another person can see.
          Everything you have written can be downloaded, or deleted along with the account, in
          one tap.{" "}
          <Link href="/settings" className="text-accent font-medium">
            Settings
          </Link>{" "}
          is where that lives, with every share link and the switch that turns all of it off.
        </p>
        <p className="text-xs text-muted/70">
          <Link href="/privacy" className="text-accent">
            Privacy
          </Link>{" "}
          ·{" "}
          <Link href="/terms" className="text-accent">
            Terms
          </Link>{" "}
          ·{" "}
          <Link href="/support" className="text-accent">
            Support
          </Link>
        </p>
      </section>
    </div>
  );
}

/**
 * One promise in the won't-do card. The lead-in sits on its own line above the
 * explanation (owner feedback 2026-10-26: "this is misaligned" — run-in bold
 * lead-ins wrapped at a different point in every item, so the explanations
 * started at a different place each time), with a ✕ in a fixed column.
 */
function WontDo({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.25rem_1fr] gap-x-3">
      <X aria-hidden size={16} strokeWidth={2.4} className="mt-1 text-accent" />
      <strong className="text-sm font-semibold leading-snug text-foreground">{title}</strong>
      <p className="col-start-2 mt-1 text-sm leading-relaxed text-muted">{children}</p>
    </li>
  );
}

function Resource({ href, name, note }: { href: string; name: string; note: string }) {
  return (
    <li className="card-flat p-4 flex flex-col gap-1">
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium text-accent"
      >
        {name}
      </a>
      <span className="text-xs text-muted leading-relaxed">{note}</span>
    </li>
  );
}
