import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { inviteFriends, listInvitableFriends, visibleOutingByCode } from "@/lib/outings";

const schema = z.object({ userIds: z.array(z.string().min(1).max(64)).min(1).max(50) }).strict();
type Ctx = { params: Promise<{ code: string }> };

async function hostOuting(code: string) {
  const user = await requireUser();
  const db = getDb();
  // The visible read (viewer suspension included), then host-only.
  const outing = await visibleOutingByCode(db, code, user.id);
  return { db, user, outing: outing && outing.hostId === user.id ? outing : null };
}

/** GET — the host's mutual friends who are not on the outing yet. */
export async function GET(_req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const { db, user, outing } = await hostOuting(code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const friends = await listInvitableFriends(db, user.id, outing.id);
    return NextResponse.json({ items: friends.map((f) => ({ userId: f.userId, handle: f.handle, displayName: f.displayName })) });
  });
}

/** POST { userIds } — send in-app invites to mutual friends (anyone else is skipped). */
export async function POST(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { db, user, outing } = await hostOuting(code);
    if (!outing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ sent: await inviteFriends(db, user.id, outing, parsed.data.userIds) });
  });
}
