import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { blockUser, getOwnProfile, listBlocked } from "@/lib/social";

const blockCreateSchema = z.object({ userId: z.string().min(1) });

/** GET /api/social/blocks — users the caller has blocked. */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const items = await listBlocked(getDb(), user.id);
    return NextResponse.json({ items });
  });
}

/** POST /api/social/blocks { userId } — block a user; 400 on self-block, 409 profile_required. */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = blockCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    if (parsed.data.userId === user.id) {
      return NextResponse.json({ error: "cannot_block_self" }, { status: 400 });
    }

    const db = getDb();
    const profile = await getOwnProfile(db, user.id);
    if (!profile) {
      return NextResponse.json({ error: "profile_required" }, { status: 409 });
    }

    const target = await db.query.user.findFirst({
      columns: { id: true },
      where: eq(schema.user.id, parsed.data.userId),
    });
    if (!target) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    await blockUser(db, user.id, parsed.data.userId);
    return NextResponse.json({ ok: true });
  });
}
