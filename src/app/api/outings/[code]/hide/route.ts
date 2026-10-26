import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { hideOutingItem, outingByCode } from "@/lib/outings";

const schema = z.object({ kind: z.enum(["tasting", "note"]), id: z.string().min(1).max(64) }).strict();

/** POST { kind, id } — the host hides a tasting or note from the outing feed. 404 for anyone else. */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { code } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const db = getDb();
    const outing = await outingByCode(db, code);
    if (!outing || !(await hideOutingItem(db, user.id, outing, parsed.data.kind, parsed.data.id))) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ hidden: true });
  });
}
