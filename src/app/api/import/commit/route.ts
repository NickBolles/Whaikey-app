import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { RELATIONSHIPS, BOTTLE_STATUSES } from "@/db/schema";
import { requireUser, withErrorHandling } from "@/lib/session";
import { readJsonWithinLimit } from "@/lib/body-limit";
import { toUserBottleValues } from "@/lib/bar";
import { isValidUpc, normalizeUpc } from "@/lib/scan";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ITEMS = 300;
/**
 * 300 shelf rows with notes is well under this; a megabyte is generous and
 * still bounded. Route handlers have no body limit of their own, so without
 * this the item cap was only checked after the whole body had been buffered
 * and parsed (review SEC-M1).
 */
const MAX_BODY_BYTES = 1024 * 1024;

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

    const body = await readJsonWithinLimit(request, MAX_BODY_BYTES);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const items = parsed.data.items;
    if (new Set(items.map((item) => item.bottleId)).size !== items.length) {
      return NextResponse.json({ error: "Each bottle may appear only once per import" }, { status: 400 });
    }

    const db = getDb();
    const ids = [...new Set(items.map((i) => i.bottleId))];
    const { added, updated, upcsTaught, skipped } = await db.transaction(async (tx) => {
      const known = new Set(
        (await tx.select({ id: schema.bottles.id }).from(schema.bottles).where(inArray(schema.bottles.id, ids))).map((r) => r.id),
      );
      const valid = items.filter((item) => known.has(item.bottleId));
      const existing = new Set(
        (
          await tx
            .select({ bottleId: schema.userBottles.bottleId })
            .from(schema.userBottles)
            .where(and(eq(schema.userBottles.userId, user.id), inArray(schema.userBottles.bottleId, valid.map((item) => item.bottleId))))
        ).map((row) => row.bottleId),
      );

      // Group by supplied optional fields so each group can be one set-based
      // UPSERT while preserving patch semantics (undefined stays untouched).
      const groups = new Map<string, typeof valid>();
      for (const item of valid) {
        const fields = ["status", "fillLevel", "quantity", "purchasePrice", "purchaseDate", "store", "location", "notes"]
          .filter((field) => item[field as keyof typeof item] !== undefined)
          .join(",");
        groups.set(fields, [...(groups.get(fields) ?? []), item]);
      }
      for (const [fields, group] of groups) {
        const included = new Set(fields ? fields.split(",") : []);
        const update = {
          relationship: sql`excluded.relationship`,
          ...(included.has("status") ? { status: sql`excluded.status` } : {}),
          ...(included.has("fillLevel") ? { fillLevel: sql`excluded.fill_level` } : {}),
          ...(included.has("quantity") ? { quantity: sql`excluded.quantity` } : {}),
          ...(included.has("purchasePrice") ? { purchasePrice: sql`excluded.purchase_price` } : {}),
          ...(included.has("purchaseDate") ? { purchaseDate: sql`excluded.purchase_date` } : {}),
          ...(included.has("store") ? { store: sql`excluded.store` } : {}),
          ...(included.has("location") ? { location: sql`excluded.location` } : {}),
          ...(included.has("notes") ? { notes: sql`excluded.notes` } : {}),
          updatedAt: new Date(),
        };
        await tx
          .insert(schema.userBottles)
          .values(
            group.map((item) => ({
              id: crypto.randomUUID(),
              userId: user.id,
              bottleId: item.bottleId,
              relationship: item.relationship,
              ...(item.relationship === "own" ? { status: "sealed" as const, fillLevel: 100, quantity: 1 } : {}),
              ...toUserBottleValues({
                status: item.status ?? undefined,
                fillLevel: item.fillLevel,
                quantity: item.quantity ?? undefined,
                purchasePrice: item.purchasePrice,
                purchaseDate: item.purchaseDate,
                store: item.store,
                location: item.location,
                notes: item.notes,
              }),
            })),
          )
          .onConflictDoUpdate({ target: [schema.userBottles.userId, schema.userBottles.bottleId], set: update });
      }
      const upcs = valid
        .map((item) => ({ ...item, upc: item.upc ? normalizeUpc(item.upc) : null }))
        .filter((item): item is typeof item & { upc: string } => Boolean(item.upc && isValidUpc(item.upc)));
      if (upcs.length > 0) {
        await tx
          .insert(schema.bottleUpcs)
          .values(upcs.map((item) => ({ id: crypto.randomUUID(), upc: item.upc, bottleId: item.bottleId, source: "user" as const, confirmedCount: 1 })))
          .onConflictDoUpdate({
            target: [schema.bottleUpcs.upc, schema.bottleUpcs.bottleId],
            set: { confirmedCount: sql`${schema.bottleUpcs.confirmedCount} + 1`, updatedAt: new Date() },
          });
      }
      const added = valid.filter((item) => !existing.has(item.bottleId)).length;
      return { added, updated: valid.length - added, upcsTaught: upcs.length, skipped: items.length - valid.length };
    });

    return NextResponse.json({ added, updated, upcsTaught, skipped });
  });
}
