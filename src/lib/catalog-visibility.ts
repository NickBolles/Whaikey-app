import { sql, type SQL } from "drizzle-orm";
import { bottles, type Bottle } from "@/db/schema";

/**
 * Who may see a user-submitted bottle (review PLAN-A1).
 *
 * A submission path has to satisfy two things that pull against each other:
 * the bottle must be usable *immediately*, or the dead end has only moved, and
 * it must not appear in everyone else's catalog before a person has looked at
 * it, or the catalog becomes whatever anyone typed. Both hold by writing a
 * real bottle row with `status: "user_submitted"` and scoping every catalog
 * read to these two helpers: the submitter sees their bottle everywhere they
 * would see any other, and nobody else sees it at all.
 *
 * This lives in its own module so `search.ts`, `recommend.ts` and the AI tools
 * can all reach it without importing the submission path they don't use.
 */

/**
 * Restrict a catalog query to what this viewer may see: everything verified or
 * imported, plus their own submissions. No id means a signed-out viewer, who
 * sees only the shared catalog.
 *
 * A `WHERE` fragment rather than a filter applied to the rows afterwards, on
 * purpose — a post-filter silently changes what a `LIMIT` means, and every one
 * of these queries has one.
 */
export function catalogVisibleTo(userId?: string): SQL {
  if (!userId) return sql`${bottles.status} <> 'user_submitted'`;
  return sql`(${bottles.status} <> 'user_submitted' OR ${bottles.submittedBy} = ${userId})`;
}

/** The same rule against a row already in hand. */
export function canViewBottle(
  bottle: Pick<Bottle, "status" | "submittedBy">,
  userId?: string,
): boolean {
  return bottle.status !== "user_submitted" || (!!userId && bottle.submittedBy === userId);
}
