import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { joinByCode } from "@/lib/clubs";

const schema = z.object({ code: z.string().min(1).max(32) }).strict();

/** POST /api/clubs/join { code } — 404 for a dead/unknown invite, 409 without a social profile. */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    const result = await joinByCode(getDb(), user.id, parsed.data.code);
    if ("error" in result) {
      const status = result.error === "invalid" ? 404 : 409;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json(result);
  });
}
