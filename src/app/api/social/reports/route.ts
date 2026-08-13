import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { createReport, getOwnProfile, reportSchema } from "@/lib/social";

/** POST /api/social/reports body reportSchema — 409 profile_required, 201 on success. */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = reportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const db = getDb();
    const profile = await getOwnProfile(db, user.id);
    if (!profile) {
      return NextResponse.json({ error: "profile_required" }, { status: 409 });
    }

    await createReport(db, user.id, parsed.data);
    return NextResponse.json({ ok: true }, { status: 201 });
  });
}
