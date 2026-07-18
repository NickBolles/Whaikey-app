import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { SERVING_STYLES, type Pour, type TastingNote } from "@/db/schema";
import { isValidLeaf } from "@/lib/flavor-wheel";

/** Standard pour when the user doesn't specify an amount. */
export const DEFAULT_POUR_ML = 45;

export class BottleNotFoundError extends Error {
  constructor(bottleId: string) {
    super(`Bottle not found: ${bottleId}`);
    this.name = "BottleNotFoundError";
  }
}

/** {leafId: intensity 1-3}; leaf ids must exist in the flavor wheel taxonomy. */
export const flavorTagsSchema = z
  .record(z.string(), z.number())
  .superRefine((tags, ctx) => {
    for (const [leafId, intensity] of Object.entries(tags)) {
      if (!isValidLeaf(leafId)) {
        ctx.addIssue({ code: "custom", message: `Unknown flavor leaf id "${leafId}"` });
      }
      if (!Number.isInteger(intensity) || intensity < 1 || intensity > 3) {
        ctx.addIssue({
          code: "custom",
          message: `Intensity for "${leafId}" must be an integer 1-3`,
        });
      }
    }
  });

export const pourInputSchema = z.object({
  bottleId: z.string().min(1),
  rating: z
    .number()
    .min(0.5, "Rating must be between 0.5 and 5")
    .max(5, "Rating must be between 0.5 and 5")
    .multipleOf(0.5, "Rating must be in half-star steps")
    .optional(),
  servingStyle: z.enum(SERVING_STYLES).optional(),
  amountMl: z.number().int().min(1).max(1000).optional(),
  context: z
    .object({
      setting: z.string().max(200).optional(),
      companions: z.string().max(200).optional(),
      glassware: z.string().max(200).optional(),
    })
    .optional(),
  note: z
    .object({
      nose: z.string().max(2000).optional(),
      palate: z.string().max(2000).optional(),
      finish: z.string().max(2000).optional(),
      freeform: z.string().max(5000).optional(),
      flavorTags: flavorTagsSchema.optional(),
    })
    .optional(),
});

export type PourInput = z.infer<typeof pourInputSchema>;

export interface LoggedPour {
  pour: Pour;
  note: TastingNote | null;
}

/** ~3% of the bottle per 30ml poured, rounded to the nearest whole percent. */
export function fillDecrementFor(amountMl: number): number {
  return Math.round((amountMl / 30) * 3);
}

function noteHasContent(note: NonNullable<PourInput["note"]>): boolean {
  return Boolean(
    note.nose?.trim() ||
      note.palate?.trim() ||
      note.finish?.trim() ||
      note.freeform?.trim() ||
      (note.flavorTags && Object.keys(note.flavorTags).length > 0),
  );
}

/**
 * Log a pour for a user. Validates input (throws ZodError on bad shape /
 * flavor tags), throws BottleNotFoundError for unknown bottles. If the user
 * has a userBottles row for the bottle the pour is linked to it, and when
 * that row is an "open" bottle with a fill level, the fill is decremented
 * ~3% per 30ml poured (floored at 0). An optional tasting note is stored
 * 1:1 with the pour.
 */
export async function logPour(db: DB, userId: string, input: PourInput): Promise<LoggedPour> {
  const parsed = pourInputSchema.parse(input);

  const bottle = await db.query.bottles.findFirst({
    where: eq(schema.bottles.id, parsed.bottleId),
  });
  if (!bottle) throw new BottleNotFoundError(parsed.bottleId);

  const userBottle = await db.query.userBottles.findFirst({
    where: and(
      eq(schema.userBottles.userId, userId),
      eq(schema.userBottles.bottleId, parsed.bottleId),
    ),
  });

  const amountMl = parsed.amountMl ?? DEFAULT_POUR_ML;

  const [pour] = await db
    .insert(schema.pours)
    .values({
      id: crypto.randomUUID(),
      userId,
      bottleId: parsed.bottleId,
      userBottleId: userBottle?.id ?? null,
      rating: parsed.rating ?? null,
      servingStyle: parsed.servingStyle ?? null,
      amountMl,
      context: parsed.context ?? null,
    })
    .returning();

  if (userBottle && userBottle.status === "open" && userBottle.fillLevel != null) {
    const nextFill = Math.max(0, userBottle.fillLevel - fillDecrementFor(amountMl));
    await db
      .update(schema.userBottles)
      .set({ fillLevel: nextFill, updatedAt: new Date() })
      .where(eq(schema.userBottles.id, userBottle.id));
  }

  let note: TastingNote | null = null;
  if (parsed.note && noteHasContent(parsed.note)) {
    const [inserted] = await db
      .insert(schema.tastingNotes)
      .values({
        id: crypto.randomUUID(),
        pourId: pour.id,
        nose: parsed.note.nose?.trim() || null,
        palate: parsed.note.palate?.trim() || null,
        finish: parsed.note.finish?.trim() || null,
        freeform: parsed.note.freeform?.trim() || null,
        flavorTags:
          parsed.note.flavorTags && Object.keys(parsed.note.flavorTags).length > 0
            ? parsed.note.flavorTags
            : null,
        extractedBy: "user",
      })
      .returning();
    note = inserted;
  }

  return { pour, note };
}

export interface PourListItem extends Pour {
  bottleName: string;
  note: TastingNote | null;
}

/** A user's pours, newest first, with joined bottle name + tasting note. */
export async function listPours(
  db: DB,
  userId: string,
  opts: { bottleId?: string; limit?: number } = {},
): Promise<PourListItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      pour: schema.pours,
      bottleName: schema.bottles.name,
      note: schema.tastingNotes,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(
      and(
        eq(schema.pours.userId, userId),
        opts.bottleId ? eq(schema.pours.bottleId, opts.bottleId) : undefined,
      ),
    )
    .orderBy(desc(schema.pours.createdAt), desc(schema.pours.id))
    .limit(limit);

  return rows.map((r) => ({ ...r.pour, bottleName: r.bottleName, note: r.note ?? null }));
}

/** One pour + note, scoped to the owner. Returns null for missing/others'. */
export async function getPour(
  db: DB,
  userId: string,
  pourId: string,
): Promise<{ pour: Pour; bottleName: string; note: TastingNote | null } | null> {
  const rows = await db
    .select({
      pour: schema.pours,
      bottleName: schema.bottles.name,
      note: schema.tastingNotes,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(and(eq(schema.pours.id, pourId), eq(schema.pours.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { pour: row.pour, bottleName: row.bottleName, note: row.note ?? null };
}

/** Delete a pour (tasting note cascades). Returns false for missing/others'. */
export async function deletePour(db: DB, userId: string, pourId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.pours)
    .where(and(eq(schema.pours.id, pourId), eq(schema.pours.userId, userId)))
    .returning({ id: schema.pours.id });
  return deleted.length > 0;
}
