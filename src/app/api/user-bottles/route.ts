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
import { recordShareConversion } from "@/lib/observability/analytics";

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
       * Best-effort, and deliberately awaited: `recordShareConversion` owns
       * both the validation query and the write, and swallows its own
       * failures, so nothing about measuring this conversion can change the
       * answer the person gets about their shelf.
       */
      await recordShareConversion(db, {
        shareId: input.fromShareId,
        bottleId: input.bottleId,
        userId: user.id,
        relationship: input.relationship,
      });
    }
    return NextResponse.json(row, { status: created ? 201 : 200 });
  });
}
