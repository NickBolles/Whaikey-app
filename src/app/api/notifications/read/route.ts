import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { markRead } from "@/lib/notify";

const bodySchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(200).optional() }).strict();

/** POST /api/notifications/read { ids? } — mark some (or all) of the caller's own notifications read. */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const marked = await markRead(getDb(), user.id, parsed.data.ids);
    return NextResponse.json({ marked });
  });
}
