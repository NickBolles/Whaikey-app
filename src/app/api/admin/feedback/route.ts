import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { feedback } from "@/db/schema";
import { getSessionUser, withErrorHandling, UnauthorizedError } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { isOperator } from "@/lib/operator";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024;

const bodySchema = z.object({ id: z.string().min(1) });

/**
 * POST /api/admin/feedback — mark one message handled (PLAN.md §9.7).
 *
 * `feedback.handledAt` is the difference between a list and a queue. Without
 * somewhere to put "I have dealt with this", the page repeats one level down
 * the mistake this lane exists to fix: a table that accumulates and nobody can
 * tell what is still outstanding.
 *
 * One direction only. Un-handling would be an undo for a mis-tap, and the cost
 * of that mis-tap is re-reading a message — not worth a second verb.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    if (!isOperator(user)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const parsed = bodySchema.safeParse(await readJsonWithinLimit(request, MAX_BODY_BYTES));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const [row] = await getDb()
      .update(feedback)
      .set({ handledAt: new Date() })
      .where(and(eq(feedback.id, parsed.data.id), isNull(feedback.handledAt)))
      .returning({ id: feedback.id });
    if (!row) return NextResponse.json({ error: "Nothing to mark" }, { status: 404 });

    return NextResponse.json({ ok: true });
  }) as Promise<NextResponse>;
}
