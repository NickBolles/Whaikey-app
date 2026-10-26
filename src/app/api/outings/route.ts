import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { OutingClubError, OutingProfileRequiredError, createOuting, listMyOutings, outingCreateSchema } from "@/lib/outings";

/** GET /api/outings — outings the caller hosts or joined. */
export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();
    return NextResponse.json({ items: await listMyOutings(getDb(), user.id) });
  });
}

/** POST /api/outings — plan a distillery outing; 403 not in the club, 409 without a social profile. */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const parsed = outingCreateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    try {
      const outing = await createOuting(getDb(), user.id, parsed.data);
      return NextResponse.json({ id: outing.id, joinCode: outing.joinCode, path: `/o/${outing.joinCode}` }, { status: 201 });
    } catch (err) {
      if (err instanceof OutingClubError) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
      if (err instanceof OutingProfileRequiredError) return NextResponse.json({ error: "profile_required" }, { status: 409 });
      throw err;
    }
  });
}
