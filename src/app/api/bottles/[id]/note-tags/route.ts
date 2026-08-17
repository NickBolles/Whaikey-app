import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
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

    const { leafId } = parsed.data;

    // One statement, so two chips tapped in the same breath cannot clobber
    // each other. Read-modify-write loses a tag whenever the second request
    // reads before the first commits, and a plain insert races the unique
    // pourId; this upsert merges inside the database instead.
    //
    // `{leaf:1} || existing` puts the existing object on the right, so its
    // value wins wherever the key is already present — the tap means "I agree
    // it's there", never "it's faint", so an intensity the user already set is
    // never lowered. Every other descriptor on the note is carried through
    // untouched.
    const merged = sql`jsonb_build_object(${leafId}::text, 1) || coalesce(${schema.tastingNotes.flavorTags}, '{}'::jsonb)`;
    const [row] = await db
      .insert(schema.tastingNotes)
      .values({
        id: crypto.randomUUID(),
        pourId: pour.id,
        flavorTags: { [leafId]: 1 },
        extractedBy: "user",
      })
      .onConflictDoUpdate({ target: schema.tastingNotes.pourId, set: { flavorTags: merged } })
      .returning({ flavorTags: schema.tastingNotes.flavorTags });

    return NextResponse.json({ pourId: pour.id, flavorTags: row?.flavorTags ?? {} });
  });
}
