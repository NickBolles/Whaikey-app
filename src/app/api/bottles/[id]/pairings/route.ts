import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { getCachedPairings, getOrGeneratePairings } from "@/lib/ai/pairings";
import { reserveAiRequest } from "@/lib/ai/rate-limit";

// Node runtime (not edge): uses the DB driver and (on cache miss) the Anthropic SDK.
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/bottles/[id]/pairings → {pairings}
 * Public reads may only return cached pairings. Cache misses require an
 * authenticated user before they can trigger paid AI generation.
 * 404 for an unknown bottle.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const { id } = await params;
    const db = getDb();
    const cached = await getCachedPairings(db, id);
    if (cached === null) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }
    if (cached.length > 0) return NextResponse.json({ pairings: cached });
    const user = await requireUser();
    if (!(await reserveAiRequest(db, user.id))) {
      return NextResponse.json({ error: "AI request limit reached. Try again later." }, { status: 429 });
    }
    const pairings = await getOrGeneratePairings(db, id);
    return NextResponse.json({ pairings });
  });
}
