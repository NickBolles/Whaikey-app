import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { clubExportCsv } from "@/lib/clubs";
import { BRAND_SLUG } from "@/lib/brand";

/** GET /api/clubs/[id]/export — the club's shared data as CSV, for members. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await ctx.params;
    const csv = await clubExportCsv(getDb(), user.id, id);
    if (csv == null) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${BRAND_SLUG}-club-${id}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
}
