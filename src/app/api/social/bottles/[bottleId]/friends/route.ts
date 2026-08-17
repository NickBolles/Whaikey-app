import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { areFriends, getFriendNotesForBottle } from "@/lib/social";

/**
 * The post-pour conversation launcher. It deliberately returns only notes a
 * mutual friend chose to make visible; a friend's shelf/inventory remains
 * private until a separate shelf-sharing consent exists.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ bottleId: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { bottleId } = await ctx.params;
    const db = getDb();
    const visibleNotes = await getFriendNotesForBottle(db, user.id, bottleId);
    const notes = (
      await Promise.all(
        visibleNotes.map(async (note) => ((await areFriends(db, user.id, note.author.userId)) ? note : null)),
      )
    )
      .filter((note): note is NonNullable<typeof note> => note !== null)
      .map((note) => ({
        pourId: note.pourId,
        author: note.author,
        createdAt: note.createdAt.toISOString(),
      }));
    return NextResponse.json({ notes });
  });
}