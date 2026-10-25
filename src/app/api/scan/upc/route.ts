import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireUser, withErrorHandling } from "@/lib/session";
import {
  candidatesFromExternalName,
  isExternalLookupEnabled,
  isValidUpc,
  lookupExternalUpc,
  normalizeUpc,
  resolveUpc,
} from "@/lib/scan";
import { recordScanEvent } from "@/lib/observability/scan-telemetry";

export const runtime = "nodejs";
export const maxDuration = 15;

const bodySchema = z.object({
  upc: z.string().min(1).max(64),
});

/**
 * POST /api/scan/upc {upc} → resolve a scanned barcode.
 *
 * Response: {
 *   upc: normalized code,
 *   matches:    own-DB mappings, most-confirmed first (usually the answer),
 *   candidates: catalog fuzzy matches from a transient external lookup,
 *               only populated when matches is empty,
 *   externalName: what the external source called the product (or null),
 * }
 * Nothing here writes catalog data: mappings are only stored when the user
 * confirms (POST /api/scan/confirm) — confirm-or-correct keeps the data
 * honest. One anonymous `scan_events` row records the outcome (M0.5).
 */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "upc is required" }, { status: 400 });
    }

    const upc = normalizeUpc(parsed.data.upc);
    if (!upc || !isValidUpc(upc)) {
      return NextResponse.json(
        { error: "Not a valid UPC/EAN barcode", upc: parsed.data.upc },
        { status: 400 },
      );
    }

    const db = getDb();
    const started = Date.now();
    const matches = await resolveUpc(db, upc);
    if (matches.length > 0) {
      await recordScanEvent(db, {
        kind: "barcode",
        outcome: "matched",
        source: "own",
        resultCount: matches.length,
        latencyMs: Date.now() - started,
      });
      return NextResponse.json({ upc, matches, candidates: [], externalName: null });
    }

    let externalName: string | null = null;
    let provider: "whiskyapi" | "upcitemdb" | "openfoodfacts" | null = null;
    let candidates: Awaited<ReturnType<typeof candidatesFromExternalName>> = [];
    if (isExternalLookupEnabled()) {
      const product = await lookupExternalUpc(upc);
      if (product) {
        externalName = product.name;
        provider = product.provider;
        candidates = await candidatesFromExternalName(db, product.name, user.id);
      }
    }

    await recordScanEvent(db, {
      kind: "barcode",
      outcome: candidates.length > 0 ? "candidates" : "miss",
      // A provider that named the product but matched nothing is still a miss,
      // attributed to the provider so its usefulness can be judged.
      source: provider ?? "none",
      upc,
      resultCount: candidates.length,
      latencyMs: Date.now() - started,
    });
    return NextResponse.json({ upc, matches: [], candidates, externalName });
  });
}
