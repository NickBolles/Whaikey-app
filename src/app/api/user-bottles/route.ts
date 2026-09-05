import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  BOTTLE_STATUSES,
  RELATIONSHIPS,
  type BottleStatus,
  type Relationship,
} from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { canViewBottle } from "@/lib/catalog-visibility";
import { listUserBottles, upsertUserBottle, userBottleCreateSchema } from "@/lib/bar";
import { recordEvent } from "@/lib/observability/analytics";

export const dynamic = "force-dynamic";

/**
 * GET /api/user-bottles?relationship=own|tried|wishlist&status=...
 * Rows joined with bottle info, ordered by updatedAt desc.
 */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const relationship = url.searchParams.get("relationship");
    const status = url.searchParams.get("status");

    if (relationship != null && !RELATIONSHIPS.includes(relationship as Relationship)) {
      return NextResponse.json({ error: "Invalid relationship filter" }, { status: 400 });
    }
    if (status != null && !BOTTLE_STATUSES.includes(status as BottleStatus)) {
      return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
    }

    const rows = await listUserBottles(getDb(), user.id, {
      relationship: (relationship as Relationship) ?? undefined,
      status: (status as BottleStatus) ?? undefined,
    });
    return NextResponse.json(rows);
  });
}

/**
 * POST /api/user-bottles — upsert by (userId, bottleId).
 * Inserts (201) with own-defaults status "sealed" / fillLevel 100 / quantity 1,
 * or updates the existing row's relationship + provided fields (200).
 */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = userBottleCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const input = parsed.data;
    const db = getDb();

    const bottle = await db.query.bottles.findFirst({
      where: eq(schema.bottles.id, input.bottleId),
    });
    // A bottle somebody else submitted and nobody has reviewed is not in this
    // user's catalog at all (PLAN-A1), so it cannot go on their shelf.
    if (!bottle || !canViewBottle(bottle, user.id)) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }

    const { row, created } = await upsertUserBottle(db, user.id, input);
    // The third step of the S1 funnel (PLAN-A5): the discovery payoff the
    // share page exists for. Only on a genuinely NEW shelf row — re-saving a
    // bottle already on the wishlist is not a conversion, and counting it
    // would make the number rise by repetition, which is the failure mode of
    // every funnel metric.
    if (created && input.fromShareId) {
      /**
       * The claim is checked, not taken.
       *
       * `fromShareId` arrives from the client, and the foreign key only proves
       * the id exists — not that this share is about this bottle, nor that the
       * caller is a recipient. Anyone holding any share id could otherwise add
       * an unrelated bottle and manufacture a conversion, and PLAN-A5's number
       * is exactly the kind that invites being flattered. Resolved server-side
       * against the share's own pour, and the owner is excluded on the same
       * reasoning as the view event: the funnel is about recipients.
       */
      const [share] = await db
        .select({ ownerId: schema.pourShares.userId, bottleId: schema.pours.bottleId })
        .from(schema.pourShares)
        .innerJoin(schema.pours, eq(schema.pours.id, schema.pourShares.pourId))
        .where(eq(schema.pourShares.id, input.fromShareId));
      if (share && share.bottleId === input.bottleId && share.ownerId !== user.id) {
        // And the relationship decides which event it is. `share_wishlist_add`
        // feeds a funnel field named `wishlistAddsFromShare`; this endpoint
        // takes the relationship from the caller, so an `own` or `tried` add
        // was being counted under a name that says wishlist. Both are real
        // conversions and neither is the other one.
        await recordEvent(
          db,
          input.relationship === "wishlist" ? "share_wishlist_add" : "share_shelf_add",
          { userId: user.id, shareId: input.fromShareId },
        );
      }
    }
    return NextResponse.json(row, { status: created ? 201 : 200 });
  });
}
