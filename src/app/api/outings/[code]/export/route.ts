import { NextResponse } from "next/server";
import { withErrorHandling } from "@/lib/session";
import { getOutingView, outingCsv } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

/** GET — the outing's feed as CSV, for anyone on it (owner: export everywhere). */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing || (!seat && outing.hostId !== user?.id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const view = await getOutingView(db, outing, user?.id ?? null, seat);
    return new NextResponse(outingCsv(view), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="whaikey-outing-${code}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
}
