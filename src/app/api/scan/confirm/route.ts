import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { RELATIONSHIPS } from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { upsertUserBottle } from "@/lib/bar";
import { canViewBottle } from "@/lib/catalog-visibility";
import { isValidUpc, normalizeUpc, resolveUpc } from "@/lib/scan";
import { teachBarcode, type TeachResult } from "@/lib/upc-crowd";
import { recordScanEvent } from "@/lib/observability/scan-telemetry";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** Present when the identification started from a barcode; omitted for label-photo scans. */
  upc: z.string().min(1).max(64).optional(),
  bottleId: z.string().min(1),
  /** When set, also add the bottle to the user's shelf in the same round trip. */
  relationship: z.enum(RELATIONSHIPS).optional(),
  /**
   * For barcode-less confirmations: which reader produced the pick — the
   * free on-device label read ("ocr"), the paid AI read ("ai"), or a search.
   * Telemetry only; lets /admin/scan show which path resolved label scans.
   */
  via: z.enum(["ocr", "ai", "search"]).optional(),
});

/**
 * POST /api/scan/confirm {upc?, bottleId, relationship?}
 *
 * The moment a scan becomes first-party data: records the user's
 * confirmation that this barcode is this bottle, and optionally adds the
 * bottle to their bar in the same call so rapid batch scanning is one
 * request per bottle.
 *
 * A confirmation of a barcode we already map strengthens that mapping (once
 * per account). A confirmation of an unknown pairing is a **pending claim**
 * (src/lib/upc-crowd.ts): it answers other people's scans only once enough
 * independent accounts agree, a trusted account confirms, or an operator
 * approves. `teach` in the response says which happened.
 */
export async function POST(request: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const upc = input.upc != null ? normalizeUpc(input.upc) : null;
    if (input.upc != null && (!upc || !isValidUpc(upc))) {
      return NextResponse.json({ error: "Not a valid UPC/EAN barcode" }, { status: 400 });
    }

    const db = getDb();
    const bottle = await db.query.bottles.findFirst({
      where: eq(schema.bottles.id, input.bottleId),
    });
    // Someone else's pending submission does not exist as far as this user is
    // concerned (PLAN-A1) — 404 rather than 403, which would confirm the id.
    if (!bottle || !canViewBottle(bottle, user.id)) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }

    const ownMatches = upc ? await resolveUpc(db, upc) : [];

    /**
     * A confirmation teaches every future scanner, so it may only be recorded
     * against a bottle everyone can see. Confirming your own submission still
     * puts it on your shelf below; the barcode is held on the submission and
     * published when the bottle is (`publishSubmissionUpc`).
     */
    // Where the confirmed bottle stood in our own answer for this barcode,
    // read BEFORE the confirmation changes the ordering: 0 means the top
    // match was right, null means our table did not offer it at all.
    const confirmRank = upc
      ? (() => {
          const i = ownMatches.findIndex((m) => m.id === input.bottleId);
          return i >= 0 ? i : null;
        })()
      : null;
    const teach: TeachResult | null =
      upc && bottle.status !== "user_submitted" ? await teachBarcode(db, user, upc, input.bottleId) : null;
    const mapping = teach?.mapping ?? null;
    await recordScanEvent(db, {
      // No barcode means the bottle was picked from a label read or a search.
      kind: upc ? "barcode" : "label",
      outcome: "confirmed",
      source: upc
        ? confirmRank != null
          ? "own"
          : "none"
        : input.via === "ocr"
          ? "ocr"
          : input.via === "ai"
            ? "ai"
            : "none",
      confirmRank,
    });

    let userBottle: schema.UserBottle | null = null;
    let created = false;
    if (input.relationship) {
      const result = await upsertUserBottle(db, user.id, {
        bottleId: input.bottleId,
        relationship: input.relationship,
      });
      userBottle = result.row;
      created = result.created;
    }

    return NextResponse.json(
      {
        mapping,
        teach: teach && {
          state: teach.state,
          confirmations: teach.confirmations,
          required: teach.required,
          taught: teach.taught,
        },
        userBottle,
        bottle: { id: bottle.id, name: bottle.name, category: bottle.category },
      },
      { status: created ? 201 : 200 },
    );
  });
}
