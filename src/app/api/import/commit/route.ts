import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { RELATIONSHIPS, BOTTLE_STATUSES } from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { upsertUserBottle } from "@/lib/bar";
import { confirmUpcMapping, isValidUpc, normalizeUpc } from "@/lib/scan";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ITEMS = 300;

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Invalid ISO date string" });

const itemSchema = z.object({
  bottleId: z.string().min(1),
  relationship: z.enum(RELATIONSHIPS),
  status: z.enum(BOTTLE_STATUSES).nullish(),
  fillLevel: z.number().int().min(0).max(100).nullish(),
  quantity: z.number().int().min(1).nullish(),
  purchasePrice: z.number().min(0).nullish(),
  purchaseDate: isoDate.nullish(),
  store: z.string().max(200).nullish(),
  location: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  /** When present (and valid), the confirmed row also teaches the UPC map. */
  upc: z.string().max(64).nullish(),
});

const bodySchema = z.object({
  items: z.array(itemSchema).min(1).max(MAX_ITEMS),
});

/**
 * POST /api/import/commit {items} → {added, updated, upcsTaught, skipped}
 *
 * The write step of the import flow: upserts each confirmed row onto the
 * user's shelf (same semantics as adding one bottle at a time) and records
 * UPC→bottle confirmations for rows that carried a barcode — a spreadsheet
 * import teaches the scanner too.
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
    const items = parsed.data.items;

    const db = getDb();
    const ids = [...new Set(items.map((i) => i.bottleId))];
    const known = new Set(
      (
        await db
          .select({ id: schema.bottles.id })
          .from(schema.bottles)
          .where(inArray(schema.bottles.id, ids))
      ).map((r) => r.id),
    );

    let added = 0;
    let updated = 0;
    let upcsTaught = 0;
    let skipped = 0;

    for (const item of items) {
      if (!known.has(item.bottleId)) {
        skipped += 1;
        continue;
      }
      const { created } = await upsertUserBottle(db, user.id, {
        bottleId: item.bottleId,
        relationship: item.relationship,
        status: item.status ?? undefined,
        fillLevel: item.fillLevel,
        quantity: item.quantity ?? undefined,
        purchasePrice: item.purchasePrice,
        purchaseDate: item.purchaseDate,
        store: item.store,
        location: item.location,
        notes: item.notes,
      });
      if (created) added += 1;
      else updated += 1;

      const upc = item.upc ? normalizeUpc(item.upc) : null;
      if (upc && isValidUpc(upc)) {
        await confirmUpcMapping(db, upc, item.bottleId);
        upcsTaught += 1;
      }
    }

    return NextResponse.json({ added, updated, upcsTaught, skipped });
  });
}
