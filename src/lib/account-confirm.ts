/**
 * The deletion confirm step, shared by `DELETE /api/account` and the dialog in
 * Settings so the two cannot disagree about what counts. A module of its own
 * because the dialog is client code and `account-data.ts` is not.
 */

/**
 * The word the confirm step asks for. Typed, not tapped: this is the one
 * action in the app with no undo, so a stray tap on a dialog button must not
 * be able to reach it.
 */
export const DELETE_CONFIRMATION = "DELETE";

/** Case-insensitive after trimming: the point is intent, not a spelling test on a phone keyboard. */
export function isDeleteConfirmation(typed: string): boolean {
  return typed.trim().toUpperCase() === DELETE_CONFIRMATION;
}
