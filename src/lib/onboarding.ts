import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

/**
 * First-run onboarding (/welcome). The cookie is the fast opt-out: it's set
 * by client JS (document.cookie, path=/, max-age one year) the moment the
 * user finishes OR skips the wizard, so Home never has to hit the database
 * for returning users. `needsOnboarding` is the slow, honest check behind
 * it — a user with any profile, bar, or pour history has nothing to be
 * onboarded into, cookie or no cookie (new device, cleared cookies).
 */
export const ONBOARDING_COOKIE = "whaikey_onboarded";

/**
 * True iff the user has no social profile AND no bar rows AND no pours —
 * i.e. a genuinely blank account that has never used the core loop.
 */
export async function needsOnboarding(db: DB, userId: string): Promise<boolean> {
  const [profile, userBottle, pour] = await Promise.all([
    db.query.userProfiles.findFirst({
      columns: { userId: true },
      where: eq(schema.userProfiles.userId, userId),
    }),
    db.query.userBottles.findFirst({
      columns: { id: true },
      where: eq(schema.userBottles.userId, userId),
    }),
    db.query.pours.findFirst({
      columns: { id: true },
      where: eq(schema.pours.userId, userId),
    }),
  ]);
  return !profile && !userBottle && !pour;
}
