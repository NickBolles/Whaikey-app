/**
 * The facts a policy document needs and code cannot invent (PLAN.md §9.3).
 *
 * A Terms and a Privacy Policy have to name a legal entity, a jurisdiction, a
 * contact address and the date they take effect. Those are the operator's to
 * supply, and writing plausible ones would be worse than leaving them blank: a
 * policy that names the wrong entity is not a smaller problem than one that
 * names none.
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

/**
 * An ISO calendar date the environment actually supplied, or null.
 *
 * Validated here rather than at the point of use so every consumer gets the
 * same answer from the same rule — the banner, the header and `isComplete`
 * were otherwise three readings of one value, which is how a page ends up
 * contradicting its own notice.
 *
 * A presence check alone let `2026-13-40` through, and the header then
 * announced "In effect since 2026-13-40" with no banner under it, because a
 * non-empty string was taken as a date. The round-trip is what rejects a real
 * shape with impossible numbers: `Date.parse` accepts `2026-02-30` and rolls
 * it forward to March, so the test is whether the date formats back to exactly
 * what was given.
 */
function isoDateOrNull(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * An address a `mailto:` can actually reach, or null.
 *
 * Same reason the date is parsed rather than counted: a presence check let
 * `support.example.com` suppress the banner and publish an unusable contact
 * link on both policy pages and `/support`, on the one fact a reader needs
 * when something has gone wrong. Deliberately a shape test and not an
 * RFC 5322 implementation — the failure this catches is a typo, and a
 * validator strict enough to argue with a real address would be its own bug.
 */
function emailOrNull(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

export function legalIdentity(): LegalIdentity {
  return {
    entity: process.env.NEXT_PUBLIC_LEGAL_ENTITY?.trim() || null,
    jurisdiction: process.env.NEXT_PUBLIC_LEGAL_JURISDICTION?.trim() || null,
    contactEmail: emailOrNull(process.env.NEXT_PUBLIC_SUPPORT_EMAIL),
    effectiveDate: isoDateOrNull(process.env.NEXT_PUBLIC_POLICY_EFFECTIVE_DATE),
  };
}

/** Exactly what a policy page is still missing, in the order it reads. */
export function missingLegalFacts(identity: LegalIdentity): string[] {
  const missing: string[] = [];
  if (!identity.entity) missing.push("the company it binds");
  if (!identity.jurisdiction) missing.push("the law it is governed by");
  // Absent covers malformed, as with the date: an unusable `mailto:` is not a
  // contact address, and this banner is what says whether the page is finished.
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
  // Absent covers malformed: `legalIdentity` nulls a value that is not a real
  // calendar date, so a typo reads as "not set yet" rather than being
  // published as the date the document binds from.
  if (!identity.effectiveDate) missing.push("the date it takes effect");
  return missing;
}

export function isComplete(identity: LegalIdentity): boolean {
  return missingLegalFacts(identity).length === 0;
}
