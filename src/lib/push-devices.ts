import { and, eq, lt } from "drizzle-orm";
import type { DB } from "@/db";
import { pushDevices } from "@/db/schema";

/**
 * Who a push token belongs to (review SEC-M6).
 *
 * The registration route used `onConflictDoUpdate` on `token`, so whoever
 * POSTed a token owned it: anyone who learned a victim's APNs/FCM token could
 * claim it and receive that person's notifications from then on. Possession of
 * the token was being treated as proof of possession of the *device*, which it
 * is not — the token is the only credential in play and it is exactly the thing
 * that leaks.
 *
 * The rule now: a token belongs to the account that registered it until that
 * account releases it (sign-out deletes the row) or stops using it. A device
 * that genuinely changes hands without a sign-out — the app deleted and
 * reinstalled, the OS reissuing the token — is covered by the staleness
 * window, because in that case nobody has refreshed the old row since.
 */

/**
 * How long a token stays with its owner without being seen again.
 *
 * The review's own number. Short enough that a phone handed on stops carrying
 * the previous owner's notifications within a week; long enough that somebody
 * who opens the app at weekends never loses theirs. Erring long costs a new
 * owner a few days without push; erring short is how the theft comes back.
 */
export const PUSH_TOKEN_CLAIM_DAYS = 7;

export type PushRegistration = "registered" | "claimed_by_another";

/**
 * Register a device token to a user, refusing to take one that is somebody
 * else's and still in use.
 */
export async function registerPushDevice(
  db: DB,
  userId: string,
  token: string,
  platform: "ios" | "android",
  now = new Date(),
): Promise<PushRegistration> {
  // Unclaimed or already ours. One statement, so two devices racing for the
  // same token cannot both read "free" and both insert.
  const [mine] = await db
    .insert(pushDevices)
    .values({ id: crypto.randomUUID(), userId, token, platform, updatedAt: now })
    .onConflictDoUpdate({
      target: pushDevices.token,
      set: { platform, updatedAt: now },
      where: eq(pushDevices.userId, userId),
    })
    .returning({ userId: pushDevices.userId });
  if (mine) return "registered";

  // Somebody else's. Taking it is right in exactly one case: nobody has
  // refreshed it for long enough that nobody is using it.
  const staleBefore = new Date(now.getTime() - PUSH_TOKEN_CLAIM_DAYS * 24 * 60 * 60 * 1000);
  const [reclaimed] = await db
    .update(pushDevices)
    .set({ userId, platform, updatedAt: now })
    .where(and(eq(pushDevices.token, token), lt(pushDevices.updatedAt, staleBefore)))
    .returning({ userId: pushDevices.userId });

  return reclaimed ? "registered" : "claimed_by_another";
}
