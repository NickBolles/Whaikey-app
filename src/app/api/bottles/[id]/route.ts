import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getSessionUser, withErrorHandling } from "@/lib/session";
import { getBottleDetail } from "@/lib/search";

/**
 * GET /api/bottles/[id]
 * Public bottle detail. Response:
 * {
 *   bottle: Bottle,
 *   distillery: Distillery | null,
 *   communityStats: { avgRating: number | null, ratingCount: number },
 *   userBottle: UserBottle | null,   // signed-in user's shelf row, else null
 *   pairings: Pairing[]
 * }
 * 404 for unknown id.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const { id } = await ctx.params;
    const user = await getSessionUser();
    const detail = await getBottleDetail(getDb(), id, user?.id);
    if (!detail) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  }) as Promise<NextResponse>;
}
