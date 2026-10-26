import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { addOutingNote, outingNoteSchema } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

/** POST { body } — a line on the outing's shared feed. 403 without a seat, 409 once ended. */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const parsed = outingNoteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { db, outing, seat } = await resolveOuting(req, code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!seat) return NextResponse.json({ error: "no_seat" }, { status: 403 });
    const row = await addOutingNote(db, outing, seat, parsed.data.body);
    if (!row) return NextResponse.json({ error: "not_open" }, { status: 409 });
    return NextResponse.json(row, { status: 201 });
  });
}
