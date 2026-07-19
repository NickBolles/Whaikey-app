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
 * Nothing here writes: mappings are only stored when the user confirms
 * (POST /api/scan/confirm) — confirm-or-correct keeps the data honest.
 */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    await requireUser();

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
    const matches = await resolveUpc(db, upc);
    if (matches.length > 0) {
      return NextResponse.json({ upc, matches, candidates: [], externalName: null });
    }

    let externalName: string | null = null;
    let candidates: Awaited<ReturnType<typeof candidatesFromExternalName>> = [];
    if (isExternalLookupEnabled()) {
      const product = await lookupExternalUpc(upc);
      if (product) {
        externalName = product.name;
        candidates = await candidatesFromExternalName(db, product.name);
      }
    }

    return NextResponse.json({ upc, matches: [], candidates, externalName });
  });
}
