import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { setBoardOptIn } from "@/lib/challenges";

const schema = z.object({ optIn: z.boolean() }).strict();

/** POST { optIn } — join or leave the friends-only breadth board (D17). */
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    await setBoardOptIn(getDb(), user.id, parsed.data.optIn);
    return NextResponse.json({ optIn: parsed.data.optIn });
  });
}
