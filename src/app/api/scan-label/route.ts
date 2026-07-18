import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { fastModel, getAnthropic, isAiConfigured } from "@/lib/ai/client";
import { parseModelJson, textFromContent } from "@/lib/ai/json";
import { searchBottlesLike, type BottleSearchResult } from "@/lib/ai/tools";

// Node runtime (not edge): uses the DB driver and the Anthropic SDK.
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // ~5MB decoded

const bodySchema = z.object({
  imageBase64: z.string().min(1),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
});

const SCAN_PROMPT = [
  "This is a photo of a whiskey bottle label. Extract what you can read.",
  "Return STRICT JSON only, no prose, no markdown fences:",
  '{"brandGuess": string|null, "expressionGuess": string|null, "ageStatement": string|null, "proof": number|null}',
  "- brandGuess: the brand/distillery name on the label.",
  "- expressionGuess: the specific expression/bottling name (without the brand if separable).",
  "- ageStatement: e.g. \"12 Year\", or null if no age statement.",
  "- proof: the stated proof (or ABV*2) as a number, or null.",
].join("\n");

interface Extracted {
  brandGuess: string | null;
  expressionGuess: string | null;
  ageStatement: string | null;
  proof: number | null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** POST /api/scan-label {imageBase64, mediaType} → {extracted, candidates} */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    await requireUser();
    if (!isAiConfigured()) {
      return NextResponse.json({ error: "AI features are not configured" }, { status: 503 });
    }

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "imageBase64 and a supported mediaType are required" },
        { status: 400 },
      );
    }

    const approxBytes = (parsed.data.imageBase64.length * 3) / 4;
    if (approxBytes > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Image too large (max 5MB)" }, { status: 413 });
    }

    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model: fastModel(),
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: parsed.data.mediaType,
                data: parsed.data.imageBase64,
              },
            },
            { type: "text", text: SCAN_PROMPT },
          ],
        },
      ],
    });

    const raw = parseModelJson(textFromContent(response.content as never));
    const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const extracted: Extracted = {
      brandGuess: cleanString(obj.brandGuess),
      expressionGuess: cleanString(obj.expressionGuess),
      ageStatement: cleanString(obj.ageStatement),
      proof: typeof obj.proof === "number" && Number.isFinite(obj.proof) ? obj.proof : null,
    };

    // Match against the catalog via the same LIKE search the concierge uses.
    const db = getDb();
    const seen = new Set<string>();
    const candidates: BottleSearchResult[] = [];
    const queries = [
      [extracted.brandGuess, extracted.expressionGuess].filter(Boolean).join(" "),
      extracted.expressionGuess ?? "",
      extracted.brandGuess ?? "",
    ].filter((q) => q.trim().length > 0);

    for (const query of queries) {
      if (candidates.length >= 3) break;
      for (const match of await searchBottlesLike(db, query, undefined, 5)) {
        if (candidates.length >= 3) break;
        if (!seen.has(match.id)) {
          seen.add(match.id);
          candidates.push(match);
        }
      }
    }

    return NextResponse.json({ extracted, candidates });
  });
}
