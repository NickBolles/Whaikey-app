import { signOut } from "@/lib/auth-client";
import { disablePush } from "@/lib/native/push";

/**
 * Signing out, everywhere it counts (review SEC-M6).
 *
 * A push token stays with the account that registered it until that account
 * releases it — and the release door is this one. Calling Better Auth's
 * `signOut` on its own leaves the row behind, so on a shared device the
 * previous account's notifications keep arriving and the next person cannot
 * register the same token for a week.
 *
 * Push first, deliberately: the DELETE needs the session it is about to end.
 * It releases **this** device only — the tokenless DELETE means "all of mine",
 * which on one phone signing out would kill notifications on the owner's
 * others and free those tokens for anybody to claim.
 *
 * A failure is retried once and then reported rather than swallowed, but it is
 * never allowed to trap anybody in the account: on the blocked age gate this is
 * the only way out. The residual exposure is bounded by the staleness window,
 * and the caller is told so it can say so.
 */
export interface SignOutResult {
  /** False when this device's push registration outlived the session. */
  pushReleased: boolean;
}

export async function signOutCompletely(): Promise<SignOutResult> {
  // Twice, because the common failure is a single dropped request and the
  // second attempt still has the session it needs. Beyond that, ending the
  // session matters more than tidying: refusing to sign somebody out because
  // a notification token would not delete is the worse outcome of the two,
  // especially on the blocked age gate where this is the only way out.
  let pushReleased = await disablePush().catch(() => false);
  if (!pushReleased) pushReleased = await disablePush().catch(() => false);

  if (!pushReleased) {
    console.warn(
      "[push] this device's registration could not be released; it stays with this account until the staleness window closes",
    );
  }

  await signOut();
  return { pushReleased };
}
