import { and, eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";

const SHARE_CODE_LENGTH = 12;

/** URL-safe, opaque code for a public share. It contains no user or pour data. */
function newShareCode(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, SHARE_CODE_LENGTH);
}

export interface PourShareOptions {
  /** A deliberately entered place label, e.g. “Back porch”; never device-derived. */
  locationLabel?: string | null;
}

export interface PublicPourShare {
  code: string;
  ownerName: string;
  bottleName: string;
  locationLabel: string | null;
  pour: { rating: number | null; servingStyle: string | null; amountMl: number | null; createdAt: Date };
  note: {
    nose: string | null;
    palate: string | null;
    finish: string | null;
    freeform: string | null;
    flavorTags: Record<string, number> | null;
  };
}

function cleanLocationLabel(value: string | null | undefined): string | null {
  const label = value?.trim();
  return label ? label.slice(0, 80) : null;
}

/**
 * Creates (or updates) the owner's single public link for a pour. The source
 * pour must belong to the requesting user; no private collection data crosses
 * this boundary.
 */
export async function createPourShare(
  db: DB,
  userId: string,
  pourId: string,
  options: PourShareOptions = {},
): Promise<{ code: string } | null> {
  const locationLabel = cleanLocationLabel(options.locationLabel);
  const existing = await db.query.pourShares.findFirst({
    where: and(eq(schema.pourShares.pourId, pourId), eq(schema.pourShares.userId, userId)),
  });
  if (existing) {
    if (options.locationLabel !== undefined) {
      await db
        .update(schema.pourShares)
        .set({ locationLabel })
        .where(and(eq(schema.pourShares.id, existing.id), eq(schema.pourShares.userId, userId)));
    }
    return { code: existing.code };
  }

  const pour = await db.query.pours.findFirst({
    where: and(eq(schema.pours.id, pourId), eq(schema.pours.userId, userId)),
  });
  if (!pour) return null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = newShareCode();
    const inserted = await db
      .insert(schema.pourShares)
      .values({ id: crypto.randomUUID(), pourId, userId, code, locationLabel })
      .onConflictDoNothing()
      .returning({ code: schema.pourShares.code });
    if (inserted[0]) return inserted[0];

    const raced = await db.query.pourShares.findFirst({
      where: and(eq(schema.pourShares.pourId, pourId), eq(schema.pourShares.userId, userId)),
    });
    if (raced) return { code: raced.code };
  }
  throw new Error("Unable to create a unique pour share link");
}

/** The deliberately limited public projection used by the share page and OG media. */
export async function getPublicPourShare(db: DB, code: string): Promise<PublicPourShare | null> {
  const rows = await db
    .select({
      code: schema.pourShares.code,
      ownerName: schema.user.name,
      bottleName: schema.bottles.name,
      locationLabel: schema.pourShares.locationLabel,
      rating: schema.pours.rating,
      servingStyle: schema.pours.servingStyle,
      amountMl: schema.pours.amountMl,
      createdAt: schema.pours.createdAt,
      nose: schema.tastingNotes.nose,
      palate: schema.tastingNotes.palate,
      finish: schema.tastingNotes.finish,
      freeform: schema.tastingNotes.freeform,
      flavorTags: schema.tastingNotes.flavorTags,
    })
    .from(schema.pourShares)
    .innerJoin(schema.pours, eq(schema.pourShares.pourId, schema.pours.id))
    .innerJoin(schema.user, eq(schema.pourShares.userId, schema.user.id))
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(eq(schema.pourShares.code, code))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    code: row.code,
    ownerName: row.ownerName,
    bottleName: row.bottleName,
    locationLabel: row.locationLabel,
    pour: { rating: row.rating, servingStyle: row.servingStyle, amountMl: row.amountMl, createdAt: row.createdAt },
    note: { nose: row.nose, palate: row.palate, finish: row.finish, freeform: row.freeform, flavorTags: row.flavorTags },
  };
}
