import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { REC_MODES, type RecMode } from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import { attachAiExplanations } from "@/lib/ai/recommend-explain";
import { recommendBottles } from "@/lib/recommend";

export const runtime = "nodejs";

function isRecMode(value: string): value is RecMode {
  return (REC_MODES as readonly string[]).includes(value);
}

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const url = new URL(req.url);

    const mode = url.searchParams.get("mode") ?? "discovery";
    if (!isRecMode(mode)) {
      return NextResponse.json(
        { error: `Invalid mode. Expected one of: ${REC_MODES.join(", ")}` },
        { status: 400 },
      );
    }

    let limit: number | undefined;
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1) {
        return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
      }
    }

    const db = getDb();
    let recommendations = await recommendBottles(db, user.id, { mode, limit });
    // AI only enriches the reasons — recommendations work fully without a key.
    if (isAiConfigured()) {
      recommendations = await attachAiExplanations(db, user.id, mode, recommendations);
    }

    return NextResponse.json({ mode, recommendations });
  });
}
