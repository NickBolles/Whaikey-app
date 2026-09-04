/**
 * The facts a policy document needs and code cannot invent (PLAN.md §9.3).
 *
 * A Terms and a Privacy Policy have to name a legal entity, a jurisdiction and
 * a contact address. Those are the operator's to supply, and writing plausible
 * ones would be worse than leaving them blank: a policy that names the wrong
 * entity is not a smaller problem than one that names none.
 *
 * So they come from the environment, and the pages say plainly when they are
 * missing rather than rendering a document that looks finished. `isComplete`
 * is what the store-readiness check should assert before submission.
 */
export interface LegalIdentity {
  entity: string | null;
  jurisdiction: string | null;
  contactEmail: string | null;
  /** ISO date the current text took effect, when the owner has set one. */
  effectiveDate: string | null;
}

export function legalIdentity(): LegalIdentity {
  return {
    entity: process.env.NEXT_PUBLIC_LEGAL_ENTITY?.trim() || null,
    jurisdiction: process.env.NEXT_PUBLIC_LEGAL_JURISDICTION?.trim() || null,
    contactEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || null,
    effectiveDate: process.env.NEXT_PUBLIC_POLICY_EFFECTIVE_DATE?.trim() || null,
  };
}

/** Exactly what a policy page is still missing, in the order it reads. */
export function missingLegalFacts(identity: LegalIdentity): string[] {
  const missing: string[] = [];
  if (!identity.entity) missing.push("the company it binds");
  if (!identity.jurisdiction) missing.push("the law it is governed by");
  if (!identity.contactEmail) missing.push("an address to reach");
  /**
   * The effective date counts, and it was optional at first.
   *
   * That let a page with the three identity facts set suppress the unfinished
   * banner while its own header said "Not yet in effect — see the note below"
   * and pointed at a note that was not rendered. A legal document with no date
   * from which it binds is not launch-ready, and this banner is the
   * store-readiness check, so it says so.
   */
  if (!identity.effectiveDate) missing.push("the date it takes effect");
  return missing;
}

export function isComplete(identity: LegalIdentity): boolean {
  return missingLegalFacts(identity).length === 0;
}
