import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandling } from "@/lib/session";
import { touchOutingPresence } from "@/lib/outings";
import { resolveOuting } from "@/lib/outings/request";

const bodySchema = z.object({ show: z.boolean().optional() }).strict();
type Ctx = { params: Promise<{ code: string }> };

/**
 * POST — heartbeat from the outing page while it is open and visible. Records
 * only that the caller has the page open, and returns which members on the
 * trip are "here now" (open in the last 2 minutes). People on the trip only;
 * nothing about pours or amounts is read or returned. Body `{ show: false }`
 * switches "Show when I'm here" off for the caller's seat (and clears it).
 */
export async function POST(req: Request, ctx: Ctx) {
  return withErrorHandling(async () => {
    const { code } = await ctx.params;
    const { db, user, outing, seat } = await resolveOuting(req, code);
    if (!outing || !seat) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const raw = await req.text().catch(() => "");
    let parsedBody: unknown = {};
    if (raw.trim()) {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "Invalid input" }, { status: 400 });
      }
    }
    const parsed = bodySchema.safeParse(parsedBody);
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const { here, show } = await touchOutingPresence(db, outing, user?.id ?? null, seat, { show: parsed.data.show });
    return NextResponse.json({ here, show }, { headers: { "cache-control": "no-store" } });
  });
}
