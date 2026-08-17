import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { makeEverythingPrivate } from "@/lib/social";

/** POST /api/social/privacy-reset — the US-11 step-back switch. Reversible; deletes nothing. */
export async function POST() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    await makeEverythingPrivate(getDb(), user.id);
    return NextResponse.json({ done: true });
  });
}
