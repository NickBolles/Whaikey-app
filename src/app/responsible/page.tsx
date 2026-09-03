import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Drinking responsibly",
  description: "Where to find help, and what Whaikey will and won't do.",
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
          Whaikey is a tasting journal. It is built to help you notice what you like — not to
          help you drink more of it.
        </p>
      </header>

      <section className="card p-5 flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">What this app won&apos;t do</h2>
        <ul className="flex flex-col gap-2.5 text-sm leading-relaxed text-muted">
          <li>
            <strong className="text-foreground">No streaks, and no &quot;you haven&apos;t
            poured in a while&quot;.</strong> Nothing here rewards drinking often, and nothing
            nudges you to pour.
          </li>
          <li>
            <strong className="text-foreground">No volume, proof or time-of-day badges.</strong>{" "}
            The passport counts distinct things you have met — regions, distilleries, cask types
            — so a 15 ml sample of something new counts the same as a bottle, and a second pour
            of the same bottle counts for nothing.
          </li>
          <li>
            <strong className="text-foreground">No leaderboards for how much anyone
            drinks.</strong> Friends&apos; surfaces compare notes and palates, never quantities.
          </li>
          <li>
            <strong className="text-foreground">The AI never encourages drinking</strong>, and
            never invents a price, a rating, or a claim about a bottle.
          </li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">What a pour actually is</h2>
        <p className="text-sm text-muted leading-relaxed">
          Whaikey&apos;s default pour is 45 ml. At 45% ABV that is about 20 ml of pure alcohol;
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
          Your notes and your shelf are private by default. Nothing you log is shared until you
          choose to share it, and what you paid never appears anywhere another person can see.
          A one-tap export of everything you have written is on the way and is not built yet —
          this page will say so until it is.{" "}
          <Link href="/sharing" className="text-accent font-medium">
            Sharing and privacy
          </Link>{" "}
          is where every share link lives, and where you can turn all of it off.
        </p>
      </section>
    </div>
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
