import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { withErrorHandling } from "@/lib/session";
import { getOrGeneratePairings } from "@/lib/ai/pairings";

/**
 * GET /api/bottles/[id]/pairings → {pairings}
 * Public read of the pairing cache; generates + caches via AI when the cache
 * is empty and AI is configured (returns [] when unconfigured and empty).
 * 404 for an unknown bottle.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const { id } = await params;
    const pairings = await getOrGeneratePairings(getDb(), id);
    if (pairings === null) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }
    return NextResponse.json({ pairings });
  });
}
