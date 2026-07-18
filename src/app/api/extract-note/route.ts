import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, withErrorHandling } from "@/lib/session";
import { isAiConfigured } from "@/lib/ai/client";
import { extractTastingNote } from "@/lib/ai/extract";

// Node runtime (not edge): uses the Anthropic SDK.
export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  text: z.string().min(1).max(8000),
});

/** POST /api/extract-note {text} → structured tasting note */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    await requireUser();
    if (!isAiConfigured()) {
      return NextResponse.json({ error: "AI features are not configured" }, { status: 503 });
    }

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "A non-empty text field is required" }, { status: 400 });
    }

    const result = await extractTastingNote(parsed.data.text);
    return NextResponse.json(result);
  });
}
