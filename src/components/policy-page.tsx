import Link from "next/link";
import { legalIdentity, missingLegalFacts, type LegalIdentity } from "@/lib/legal";

/**
 * The shared frame for `/terms` and `/privacy` (PLAN.md §9.3).
 *
 * Its one non-obvious job is the banner: when the operator has not supplied a
 * legal entity, jurisdiction, contact address and effective date, the page
 * says so at the top — naming only the ones actually absent — instead of
 * quietly rendering a document that reads as finished. A policy missing the
 * party it binds is not a draft detail, and a reader deserves to know which
 * they are looking at.
 *
 * Everything below the banner has to agree with it, which is the other half of
 * the same job: a notice that says the company is unnamed on a page that names
 * it, or prose that calls a configured jurisdiction unpublished, teaches the
 * reader to stop believing the notice — and this notice is the store-readiness
 * check.
 */
/** "a, b and c" — an operator reads this, not a machine. */
function readableList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function PolicyPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated?: string;
  children: React.ReactNode;
}) {
  const identity = legalIdentity();
  const missing = missingLegalFacts(identity);
  return (
    <div className="px-4 py-8 max-w-2xl mx-auto w-full flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted">
          {identity.effectiveDate
            ? `In effect since ${identity.effectiveDate}.`
            : "Not yet in effect — see the note below."}
          {updated && ` ${updated}`}
        </p>
      </header>

      {missing.length > 0 && (
        <div role="note" className="card border-danger/50 p-4 text-sm leading-relaxed">
          <strong className="text-foreground">This document is not finished.</strong>{" "}
          <span className="text-muted">
            {/* Only what is actually absent. A fixed list said the company was
                unnamed on a page that names it, which makes the notice easy to
                stop believing — and this notice is the store-readiness check. */}
            It does not yet name {readableList(missing)}. {missing.length === 1 ? "That is" : "Those are"}{" "}
            set by the operator before launch (PLAN.md §9.3); until then treat this as a
            description of how the app behaves, not as an agreement.
          </span>
        </div>
      )}

      <div className="flex flex-col gap-5 text-sm leading-relaxed text-muted">{children}</div>

      <Identity identity={identity} />

      <p className="text-xs text-muted/70">
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
        </Link>{" "}
        ·{" "}
        <Link href="/responsible" className="text-accent">
          Drinking responsibly
        </Link>
      </p>
    </div>
  );
}

function Identity({ identity }: { identity: LegalIdentity }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-lg font-semibold">Who this is</h2>
      <p className="text-sm text-muted leading-relaxed">
        {/* Each fact stands or falls on its own.
            The company used to gate both: with a jurisdiction configured and
            an entity still missing, this said the governing law was unpublished
            and threw away the value the environment supplied — while the banner
            three lines up correctly named only the company as absent. Partial
            configuration is the expected unfinished state, so a page that
            contradicts its own notice about it teaches the reader to stop
            believing the notice, which is the one thing the notice cannot
            afford. */}
        {identity.entity && identity.jurisdiction ? (
          <>
            Whaikey is operated by <strong className="text-foreground">{identity.entity}</strong>{" "}
            under the laws of {identity.jurisdiction}.
          </>
        ) : identity.entity ? (
          <>
            Whaikey is operated by <strong className="text-foreground">{identity.entity}</strong>.
            The governing law is not yet published here.
          </>
        ) : identity.jurisdiction ? (
          <>
            This document is governed by the laws of {identity.jurisdiction}. The operating company
            is not yet published here.
          </>
        ) : (
          <>The operating company and governing law are not yet published here.</>
        )}{" "}
        {identity.contactEmail ? (
          <>
            Reach us at{" "}
            <a href={`mailto:${identity.contactEmail}`} className="text-accent">
              {identity.contactEmail}
            </a>
            , or through{" "}
            <Link href="/support" className="text-accent">
              the support page
            </Link>
            .
          </>
        ) : (
          <>
            Until an address is published,{" "}
            <Link href="/support" className="text-accent">
              the support page
            </Link>{" "}
            is the way to reach us — it reaches the same person.
          </>
        )}
      </p>
    </section>
  );
}
