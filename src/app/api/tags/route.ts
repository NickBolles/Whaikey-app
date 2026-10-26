import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { listTagSuggestions } from "@/lib/tags";

/** GET /api/tags — the signed-in user's own tags, most used first (pour-sheet suggestions). */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const tags = await listTagSuggestions(getDb(), user.id, 12);
    return NextResponse.json({ tags });
  });
}
