import Link from "next/link";
import { MapPin, NotebookPen, Radar, ScanBarcode, ShieldCheck, Sparkles, Stamp } from "lucide-react";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";
import { BrandLockup, BrandMark } from "@/components/brand-mark";

/**
 * The signed-out front door (owner feedback 2026-10-26: "this home page should
 * be a marketing page, not a home of the app"). A visitor with no account gets
 * a landing page — what the app is, what it will never do, one way in — and
 * none of the app's chrome: the header and bottom nav stand down on `/` when
 * nobody is signed in (`isMarketingRoute` in src/lib/app-routes.ts).
 *
 * Copy rules: describe only what ships today, invent no numbers or reviews,
 * and keep the responsible-drinking stance (docs/PLAN.md §9.8) on the page —
 * nothing here sells drinking more.
 */
const FEATURES = [
  {
    icon: ScanBarcode,
    title: "Your bar, catalogued",
    body: "Scan a barcode or snap the label and the bottle is on your shelf — open, sealed, or on the wishlist.",
  },
  {
    icon: NotebookPen,
    title: "Tasting notes that remember",
    body: "Log what you tasted, how you rated it and what you picked up on the flavour wheel. Your journal does the remembering.",
  },
  {
    icon: Radar,
    title: "Know your palate",
    body: "Your notes add up to a picture of your palate, so the next bottle you try is a better guess than the last.",
  },
  {
    icon: MapPin,
    title: "Outings and tasting nights",
    body: "Heading to a distillery or hosting a blind flight? Friends join from a link or QR — no account needed for the day — and everyone gets the recap.",
  },
  {
    icon: Sparkles,
    title: "A concierge that knows your shelf",
    body: "Ask anything about whiskey, or what to open tonight from the bottles you already own.",
  },
  {
    icon: Stamp,
    title: "A passport, not a scoreboard",
    body: "Collect the regions, distilleries and cask types you have met. A 15 ml sample counts the same as a bottle.",
  },
] as const;

export function MarketingLanding() {
  return (
    <div className="flex flex-col">
      <div className="rule-double flex h-12 items-center justify-between border-b-[3px] pl-3 pr-2">
        <span className="font-display text-xl font-semibold tracking-tight text-foreground">
          <BrandLockup size={20} />
        </span>
        <Link
          href="/sign-in"
          className="tap-target inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium text-accent"
        >
          Sign in
        </Link>
      </div>

      <section className="flex flex-col items-center gap-4 px-3 pb-6 pt-6 text-center">
        <div aria-hidden className="text-foreground">
          <BrandMark size={56} />
        </div>
        <div>
          <p className="kicker text-editorial">{BRAND_TAGLINE}</p>
          <h1 className="mt-2 font-display text-[2.6rem] font-semibold leading-[1.05] tracking-tight text-gradient-amber">
            {BRAND_NAME}
          </h1>
          <p className="mt-2 font-display text-xl leading-snug text-foreground">
            The whiskey journal for the people around the table.
          </p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
            Track your bottles, keep tasting notes worth rereading, learn your palate — and share the good
            ones with friends.
          </p>
        </div>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <Link href="/sign-in" className="btn-primary px-10 py-3 text-base">
            Get started
          </Link>
          <Link href="/search" className="btn-secondary px-6 py-3 text-sm">
            Browse bottles first
          </Link>
        </div>
        <p className="text-xs text-muted/70">Your notes stay yours. Of legal drinking age only.</p>
      </section>

      <section aria-labelledby="landing-features" className="border-t border-border px-3 py-4">
        <h2 id="landing-features" className="section-label text-center">
          What it does
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="card-flat flex gap-3 p-3">
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"
              >
                <Icon size={18} strokeWidth={1.8} />
              </span>
              <div>
                <h3 className="font-display text-base font-semibold leading-snug">{title}</h3>
                <p className="mt-0.5 text-sm leading-relaxed text-muted">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="landing-promise" className="px-3 pb-4">
        <div className="card flex flex-col gap-2 p-3">
          <div className="flex items-center gap-2 text-accent">
            <ShieldCheck size={20} strokeWidth={1.8} aria-hidden />
            <h2 id="landing-promise" className="font-display text-lg font-semibold text-foreground">
              Built for noticing, not for more
            </h2>
          </div>
          <p className="text-sm leading-relaxed text-muted">
            You decide who sees each pour — only you, or your friends — and what you paid is never
            shown to anyone. No streaks, no volume badges, no leaderboards for how much anyone drinks, and
            nothing that nudges you to pour.
          </p>
          <Link href="/responsible" className="tap-target inline-flex min-h-11 items-center text-sm font-medium text-accent">
            How we think about drinking responsibly →
          </Link>
        </div>
      </section>

      <section className="flex flex-col items-center gap-3 border-t border-border px-3 py-6 text-center">
        <p className="font-display text-xl font-semibold">Pull up a chair.</p>
        <Link href="/sign-in" className="btn-primary px-10 py-3 text-base">
          Create your account
        </Link>
      </section>

      <footer className="flex flex-wrap items-center justify-center gap-x-1 border-t border-border px-3 py-3 text-xs text-muted">
        {[
          ["/responsible", "Drinking responsibly"],
          ["/privacy", "Privacy"],
          ["/terms", "Terms"],
          ["/support", "Support"],
        ].map(([href, label]) => (
          <Link key={href} href={href} className="tap-target inline-flex min-h-11 items-center px-2">
            {label}
          </Link>
        ))}
      </footer>
    </div>
  );
}
