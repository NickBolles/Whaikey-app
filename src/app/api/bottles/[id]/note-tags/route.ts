import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { isValidLeaf } from "@/lib/flavor-wheel";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  leafId: z.string().min(1).refine(isValidLeaf, "Unknown flavor leaf id"),
});

/**
 * POST /api/bottles/[id]/note-tags — add one flavor (at intensity 1) to the
 * signed-in user's note on their LATEST pour of this bottle, creating the
 * tasting-note row if the pour doesn't have one yet. This backs the
 * comparison screen's "+" chips: "they got this, you didn't — tap to agree".
 * 404 when the user has never poured the bottle: a comparison can suggest a
 * flavor, but only a real pour can carry a note.
 */
export async function POST(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id: bottleId } = await ctx.params;
    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const db = getDb();
    const [pour] = await db
      .select({ id: schema.pours.id })
      .from(schema.pours)
      .where(and(eq(schema.pours.userId, user.id), eq(schema.pours.bottleId, bottleId)))
      .orderBy(desc(schema.pours.createdAt))
      .limit(1);
    if (!pour) {
      return NextResponse.json({ error: "No pour of this bottle to note" }, { status: 404 });
    }

    const existing = await db.query.tastingNotes.findFirst({
      where: eq(schema.tastingNotes.pourId, pour.id),
    });

    const { leafId } = parsed.data;
    if (existing) {
      // Never lower an intensity the user already set — the tap means "I
      // agree it's there", not "it's faint".
      const flavorTags = { ...(existing.flavorTags ?? {}) };
      flavorTags[leafId] = Math.max(flavorTags[leafId] ?? 0, 1);
      await db
        .update(schema.tastingNotes)
        .set({ flavorTags })
        .where(eq(schema.tastingNotes.id, existing.id));
      return NextResponse.json({ pourId: pour.id, flavorTags });
    }

    const flavorTags = { [leafId]: 1 };
    await db.insert(schema.tastingNotes).values({
      id: crypto.randomUUID(),
      pourId: pour.id,
      flavorTags,
      extractedBy: "user",
    });
    return NextResponse.json({ pourId: pour.id, flavorTags });
  });
}
