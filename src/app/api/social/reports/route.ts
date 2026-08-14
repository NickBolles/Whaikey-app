import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { RateLimitedError, createReport, reportSchema } from "@/lib/social";

/** POST /api/social/reports body reportSchema — 201 on success; no profile required (safety action). */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await req.json().catch(() => null);
    const parsed = reportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    // Deliberately NO profile requirement: reporting is a safety action that
    // identifies the reporter by user id — encountering abuse must not
    // require claiming a handle first (docs/SOCIAL.md §11).
    const db = getDb();
    let created;
    try {
      created = await createReport(db, user.id, parsed.data);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      }
      throw err;
    }
    if (!created) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  });
}
