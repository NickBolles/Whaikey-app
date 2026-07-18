import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { getChatSessions } from "@/lib/ai/chat";

/** GET /api/chat/sessions → {sessions} newest-activity first */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const sessions = await getChatSessions(getDb(), user.id);
    return NextResponse.json({ sessions });
  });
}
