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
import { listUserBottles, upsertUserBottle, userBottleCreateSchema } from "@/lib/bar";

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
    if (!bottle) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }

    const { row, created } = await upsertUserBottle(db, user.id, input);
    return NextResponse.json(row, { status: created ? 201 : 200 });
  });
}
