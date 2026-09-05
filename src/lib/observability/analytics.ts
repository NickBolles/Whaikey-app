import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import type { AnalyticsEventName, Relationship } from "@/db/schema";

/**
 * First-party product events — the S1 share funnel, and nothing else (WP-19).
 *
 * **No third-party analytics SDK, on the server or the client.** A pour
 * timestamp shipped to a vendor is exactly the data `docs/SOCIAL.md` says
 * never crosses a boundary, and a client SDK would carry page URLs — which on
 * `/s/<code>` means the share code, a bearer credential. So these rows are
 * written server-side, into this database, and the only identifier they hold
 * is the `pour_shares` row id: never the code.
 *
 * **Recording must not be able to break the page.** Every function here
 * swallows its own failures. A share link that 500s because telemetry could
 * not write would be the measurement destroying the thing it measures.
 */

/** Resolve a share code to its row id. The id is safe to store; the code is not. */
export async function shareIdForCode(db: DB, code: string): Promise<string | null> {
  try {
    const row = await db.query.pourShares.findFirst({
      columns: { id: true },
      where: eq(schema.pourShares.code, code),
    });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The share-link conversion, validated and recorded as ONE best-effort step.
 *
 * The validation query used to sit in the route, after `upsertUserBottle` had
 * already committed and outside any guard. A database blip there produced the
 * worst available outcome: `withErrorHandling` turned it into a 500, so the
 * UI told the person their bottle had not been added — when it had — and the
 * retry then found the existing row, so `created` was false and the
 * conversion was never counted either. A lost metric is a nuisance; a
 * successful write reported as a failure is a lie to the user.
 *
 * That is precisely what this module's contract forbids, so the check lives
 * here now rather than beside the write: **everything about measuring a
 * conversion, including the query that decides whether there was one, is
 * inside the boundary that swallows its own failures.**
 *
 * The claim itself is still checked rather than taken. `fromShareId` comes
 * from the client and the foreign key only proves the id exists — not that
 * the share is about this bottle, nor that the caller is a recipient. Anyone
 * holding any share id could otherwise manufacture a conversion in the number
 * PLAN-A5's phase gate turns on. Resolved against the share's own pour, with
 * the owner excluded on the same reasoning as the view event.
 */
export async function recordShareConversion(
  db: DB,
  input: { shareId: string; bottleId: string; userId: string; relationship: Relationship },
): Promise<void> {
  try {
    const [share] = await db
      .select({ ownerId: schema.pourShares.userId, bottleId: schema.pours.bottleId })
      .from(schema.pourShares)
      .innerJoin(schema.pours, eq(schema.pours.id, schema.pourShares.pourId))
      .where(eq(schema.pourShares.id, input.shareId));
    if (!share || share.bottleId !== input.bottleId || share.ownerId === input.userId) return;

    // The relationship decides which event it is: `share_wishlist_add` feeds a
    // funnel field named `wishlistAddsFromShare`, and an `own` or `tried` add
    // is a real conversion under a different name rather than that one.
    await recordEvent(
      db,
      input.relationship === "wishlist" ? "share_wishlist_add" : "share_shelf_add",
      { userId: input.userId, shareId: input.shareId },
    );
  } catch (err) {
    console.error("[analytics] failed to record a share conversion", err);
  }
}

export async function recordEvent(
  db: DB,
  name: AnalyticsEventName,
  opts: { userId?: string | null; shareId?: string | null } = {},
): Promise<void> {
  try {
    await db.insert(schema.analyticsEvents).values({
      id: crypto.randomUUID(),
      name,
      userId: opts.userId ?? null,
      shareId: opts.shareId ?? null,
    });
  } catch (err) {
    console.error(`[analytics] failed to record ${name}`, err);
  }
}
