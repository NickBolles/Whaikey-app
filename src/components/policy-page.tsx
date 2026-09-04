import Link from "next/link";
import { isComplete, legalIdentity, type LegalIdentity } from "@/lib/legal";

/**
 * The shared frame for `/terms` and `/privacy` (PLAN.md §9.3).
 *
 * Its one non-obvious job is the banner: when the operator has not supplied a
 * legal entity, jurisdiction and contact address, the page says so at the top
 * instead of quietly rendering a document that reads as finished. A policy
 * missing the party it binds is not a draft detail, and a reader deserves to
 * know which they are looking at.
 */
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

      {!isComplete(identity) && (
        <div role="note" className="card border-danger/50 p-4 text-sm leading-relaxed">
          <strong className="text-foreground">This document is not finished.</strong>{" "}
          <span className="text-muted">
            It does not yet name the company it binds, the law it is governed by, or an address to
            reach. Those are set by the operator before launch (PLAN.md §9.3); until then treat
            this as a description of how the app behaves, not as an agreement.
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
        {identity.entity ? (
          <>
            Whaikey is operated by <strong className="text-foreground">{identity.entity}</strong>
            {identity.jurisdiction && <> under the laws of {identity.jurisdiction}</>}.
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
