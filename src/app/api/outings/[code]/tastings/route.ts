import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { addTasting, tastingSchema } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

/**
 * POST — log something you tasted on the outing: a catalog bottle (or your
 * own submission) by `bottleId`, or anything by `label` — a cask sample, a
 * distillery-only bottling. 403 without a seat, 409 once the outing ended.
 */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const parsed = tastingSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { db, outing, seat } = await resolveOuting(req, code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!seat) return NextResponse.json({ error: "no_seat" }, { status: 403 });
    const result = await addTasting(db, outing, seat, parsed.data);
    if ("error" in result) {
      if (result.error === "bottle_not_found") return NextResponse.json({ error: "bottle_not_found" }, { status: 404 });
      if (result.error === "too_many") return NextResponse.json({ error: "too_many" }, { status: 429 });
      return NextResponse.json({ error: "not_open" }, { status: 409 });
    }
    return NextResponse.json(result, { status: 201 });
  });
}
