import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { hideEntry } from "@/lib/flights";

/** POST — the host removes one note from the table; 404 for anyone else. */
export async function POST(_req: Request, ctx: { params: Promise<{ code: string; entryId: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { entryId } = await ctx.params;
    if (!(await hideEntry(getDb(), user.id, entryId))) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ hidden: true });
  });
}
