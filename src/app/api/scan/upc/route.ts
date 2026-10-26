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
import { communitySuggestions } from "@/lib/upc-crowd";
import { noteBottleSignals } from "@/lib/popularity";
import type { ScanSource } from "@/db/schema";

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
 *   matches:    own-DB mappings, most-confirmed first (usually the answer);
 *               when there are none, the viewer's OWN pending claim for this
 *               barcode (flagged `pending: true`), so re-scanning your bottle
 *               resolves before the crowd has verified it,
 *   candidates: other people's pending claims first (`community: true`),
 *               then catalog fuzzy matches from the external lookup
 *               (src/lib/upc-providers.ts — cached, budgeted, backed off),
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
      // Popularity: the bottle this barcode resolves to (anonymous daily tally).
      noteBottleSignals(db, [matches[0].id], "scan", request.headers.get("user-agent"));
      return NextResponse.json({ upc, matches, candidates: [], externalName: null });
    }

    // Prefer first-party knowledge: pending crowd claims before any provider.
    const community = await communitySuggestions(db, upc, user.id);
    const mine = community.filter((c) => c.mine).map((c) => ({ ...c, pending: true }));
    const others = community.filter((c) => !c.mine).map((c) => ({ ...c, community: true }));
    if (mine.length > 0) {
      await recordScanEvent(db, {
        kind: "barcode",
        outcome: "candidates",
        source: "community",
        upc,
        resultCount: mine.length + others.length,
        latencyMs: Date.now() - started,
      });
      return NextResponse.json({ upc, matches: mine, candidates: others, externalName: null });
    }

    let externalName: string | null = null;
    let provider: ScanSource | null = null;
    let external: Awaited<ReturnType<typeof candidatesFromExternalName>> = [];
    if (isExternalLookupEnabled()) {
      const { product } = await lookupExternalUpc(db, upc);
      if (product) {
        externalName = product.name;
        provider = product.provider;
        external = await candidatesFromExternalName(db, product.name, user.id);
      }
    }
    const seen = new Set(others.map((c) => c.id));
    const candidates = [...others, ...external.filter((c) => !seen.has(c.id))];

    await recordScanEvent(db, {
      kind: "barcode",
      outcome: candidates.length > 0 ? "candidates" : "miss",
      // A provider that named the product but matched nothing is still a miss,
      // attributed to the provider so its usefulness can be judged.
      source: others.length > 0 ? "community" : (provider ?? "none"),
      upc,
      resultCount: candidates.length,
      latencyMs: Date.now() - started,
    });
    return NextResponse.json({ upc, matches: [], candidates, externalName });
  });
}
