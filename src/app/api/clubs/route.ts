import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { ClubProfileRequiredError, clubCreateSchema, createClub, listMyClubs } from "@/lib/clubs";

/** GET /api/clubs — the caller's clubs. */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    return NextResponse.json({ items: await listMyClubs(getDb(), user.id) });
  });
}

/** POST /api/clubs { name, description? } — create an invite-only club; 409 without a social profile. */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const parsed = clubCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    try {
      const club = await createClub(getDb(), user.id, parsed.data);
      return NextResponse.json({ id: club.id, name: club.name }, { status: 201 });
    } catch (err) {
      if (err instanceof ClubProfileRequiredError) return NextResponse.json({ error: "profile_required" }, { status: 409 });
      throw err;
    }
  });
}
