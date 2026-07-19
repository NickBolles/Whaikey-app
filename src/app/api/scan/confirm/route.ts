import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { RELATIONSHIPS } from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { upsertUserBottle } from "@/lib/bar";
import { confirmUpcMapping, isValidUpc, normalizeUpc } from "@/lib/scan";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** Present when the identification started from a barcode; omitted for label-photo scans. */
  upc: z.string().min(1).max(64).optional(),
  bottleId: z.string().min(1),
  /** When set, also add the bottle to the user's shelf in the same round trip. */
  relationship: z.enum(RELATIONSHIPS).optional(),
});

/**
 * POST /api/scan/confirm {upc?, bottleId, relationship?}
 *
 * The moment a scan becomes first-party data: records the user's
 * confirmation that this barcode is this bottle (creating or strengthening
 * the crowdsourced mapping — later scanners resolve instantly), and
 * optionally adds the bottle to their bar in the same call so rapid batch
 * scanning is one request per bottle.
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
    if (!bottle) {
      return NextResponse.json({ error: "Bottle not found" }, { status: 404 });
    }

    const mapping = upc ? await confirmUpcMapping(db, upc, input.bottleId) : null;

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
        userBottle,
        bottle: { id: bottle.id, name: bottle.name, category: bottle.category },
      },
      { status: created ? 201 : 200 },
    );
  });
}
