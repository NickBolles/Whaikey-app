import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { addOutingBottle, outingBottleSchema } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

/**
 * POST — put a bottle on the outing's shared list (by `bottleId` from search
 * or a scan, or a typed `label`). Idempotent per bottle: 200 with
 * `existed: true` when it's already there, 201 when new. 403 without a seat,
 * 409 once the outing ended.
 */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const parsed = outingBottleSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { db, outing, seat } = await resolveOuting(req, code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!seat) return NextResponse.json({ error: "no_seat" }, { status: 403 });
    const result = await addOutingBottle(db, outing, seat, parsed.data);
    if ("error" in result) {
      if (result.error === "bottle_not_found") return NextResponse.json({ error: "bottle_not_found" }, { status: 404 });
      if (result.error === "too_many") return NextResponse.json({ error: "too_many" }, { status: 429 });
      return NextResponse.json({ error: "not_open" }, { status: 409 });
    }
    return NextResponse.json(result, { status: result.existed ? 200 : 201 });
  });
}
