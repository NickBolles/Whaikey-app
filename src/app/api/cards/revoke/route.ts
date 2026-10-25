import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { revokeAllCards } from "@/lib/cards";

/** POST /api/cards/revoke — every share-card link you've shared stops opening, permanently. */
export async function POST() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    await revokeAllCards(getDb(), user.id);
    return NextResponse.json({ revoked: true });
  });
}
