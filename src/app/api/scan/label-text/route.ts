import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { LABEL_MATCH_THRESHOLD, matchLabelText } from "@/lib/label-match";
import { recordScanEvent } from "@/lib/observability/scan-telemetry";

export const runtime = "nodejs";
export const maxDuration = 10;

/** Recognized text only — a label is a few hundred words at most. */
const MAX_BODY_BYTES = 32 * 1024;

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        text: z.string().max(300),
        height: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .min(1)
    .max(200),
  /** Which on-device engine read it — informational, for debugging device reports. */
  engine: z.enum(["vision", "mlkit"]).optional(),
});

/**
 * POST /api/scan/label-text {lines:[{text,height?,confidence?}], engine?}
 *   → {candidates, confidence, confident, threshold, signals:{ageYears, abv}}
 *
 * The free first pass of a label scan (M1 / A5). The phone's own text
 * recognition (iOS Vision / Android ML Kit, src/lib/native/ocr.ts) reads the
 * label; this matches the words against the catalog with no AI call. When
 * `confident` is false the client sends the photo to `/api/scan-label` (paid
 * AI vision) instead, and this request is recorded as `deferred` so the
 * label funnel counts the scan once, under whichever path answered it.
 *
 * The text is used for this request only and never stored.
 */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await readJsonWithinLimit(request, MAX_BODY_BYTES);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "lines of recognized text are required" }, { status: 400 });
    }

    const db = getDb();
    const started = Date.now();
    const result = await matchLabelText(db, parsed.data.lines, { viewerId: user.id });

    await recordScanEvent(db, {
      kind: "label",
      outcome: result.confident ? "candidates" : "deferred",
      source: "ocr",
      resultCount: result.candidates.length,
      latencyMs: Date.now() - started,
    });

    return NextResponse.json({
      candidates: result.candidates,
      confidence: result.confidence,
      confident: result.confident,
      threshold: LABEL_MATCH_THRESHOLD,
      signals: { ageYears: result.signals.ageYears, abv: result.signals.abv },
    });
  });
}
