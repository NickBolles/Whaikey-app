/**
 * One rule for whether a comment is withdrawn from everyone but its author.
 *
 * Its own module because `social.ts` and `moderation.ts` both need it and
 * `social.ts` already imports `moderation.ts` — the same split
 * `catalog-visibility.ts` exists for. The queue had the rule written out by
 * hand as `socialEnabled === true`, which is exactly how it went stale the
 * moment the predicate grew a second condition.
 */

/**
 * A stepped-back author's comments vanish for everyone but themself (US-11).
 *
 * A pure predicate rather than a rule written twice: `listComments` applies it
 * per row inside a bulk read, and `createReport` applies it to one comment, so
 * neither can call the other without reintroducing an N+1 or a cycle — but
 * both can call this. It exists because the report path did *not* apply it,
 * and a caller holding a stale comment id could report a comment the app had
 * stopped showing them, capturing its current body — possibly a revision made
 * after the step-back — into the queue as report-time evidence.
 */
export function commentWithdrawnByAuthor(
  author: {
    socialEnabled: boolean | null | undefined;
    /** When the author's profile was created, if they have one. */
    profileCreatedAt: Date | null | undefined;
  },
  comment: { userId: string; createdAt: Date },
  viewerId: string | null,
): boolean {
  /**
   * A **missing** profile counts as withdrawn, not as enabled.
   *
   * `addComment` refuses a commenter with no profile now, but that guards
   * future writes only: comments written under the old behaviour are still
   * there, with a null `socialEnabled` from the left join. Read as "not
   * false" they stayed visible and reportable — and their author cannot be
   * suspended, because `suspendAccount` needs the profile row that does not
   * exist, so an operator could hide each one and never stop the next.
   *
   * `!== true` rather than `=== false` makes no-profile the same answer as
   * social-switched-off here, which is the rule `logPour`,
   * `updatePourVisibility` and `addComment` already apply. The author still
   * sees their own comment, exactly as a stepped-back author does.
   */
  // The author always sees their own, exactly as a stepped-back author does.
  if (comment.userId === viewerId) return false;
  if (author.socialEnabled !== true) return true;
  /**
   * And a comment written **before** its author had a profile stays withdrawn
   * once they claim one.
   *
   * Clamping the account's old pours at `createProfile` closed the same door
   * one table over and left this one open: claiming a handle flipped
   * `socialEnabled` from null to true and republished every historical comment
   * at once, under whatever parent pours are still readable, with no
   * per-object choice by anyone. `docs/SOCIAL.md` is unambiguous — visibility
   * is opt-in per object and never raised retroactively.
   *
   * Derived rather than stored, because the comparison **is** the question:
   * `addComment` requires a profile now, so no new comment can predate its
   * author's, and only rows written under the old behaviour can satisfy this.
   * A stored flag would need a per-comment control to clear it, and there
   * isn't one — comments have no visibility of their own. That is the honest
   * limitation here: these stay withdrawn until Lane B gives comments a
   * per-object control, or the author deletes and reposts. Publishing them
   * instead would break the rule the whole model rests on.
   *
   * `<`, not `<=`: a comment sharing its millisecond with the profile was
   * written after it, and erring visible there is the safe direction — the
   * author chose to post it as a social account.
   */
  return author.profileCreatedAt != null && comment.createdAt < author.profileCreatedAt;
}
