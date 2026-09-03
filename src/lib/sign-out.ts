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
 * Its failure is not allowed to trap anybody in the account — a device that
 * cannot reach the server also cannot receive a notification from it, and the
 * next registration on that token will find a row nobody has refreshed.
 */
export async function signOutCompletely(): Promise<void> {
  await disablePush().catch(() => {});
  await signOut();
}
