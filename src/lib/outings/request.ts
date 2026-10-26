import { getDb } from "@/db";
import { getSessionUser, requireUser } from "@/lib/session";
import { findOutingSeat, outingGuestCookieName, visibleOutingByCode } from "@/lib/outings";

export function readOutingGuestToken(cookieHeader: string | null, joinCode: string): string | null {
  if (!cookieHeader) return null;
  const name = outingGuestCookieName(joinCode);
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Every outing route starts here: the outing as this caller may see it (host
 * reachable, no block — §13), and their seat from the account or the guest
 * cookie. `outing` is null when the code is unknown or not visible.
 */
export async function resolveOuting(req: Request, code: string) {
  const db = getDb();
  // A signed-in caller answers the account's age gate (PLAN §9.1) even when
  // they also hold a guest cookie: signing in must never be a way around it.
  // Signed out, the guest cookie's own 21+ check is what seated them.
  const user = (await getSessionUser()) ? await requireUser() : null;
  const outing = await visibleOutingByCode(db, code, user?.id ?? null);
  const seat = outing
    ? await findOutingSeat(db, outing.id, { userId: user?.id ?? null, guestToken: readOutingGuestToken(req.headers.get("cookie"), code) })
    : null;
  return { db, user, outing, seat };
}
