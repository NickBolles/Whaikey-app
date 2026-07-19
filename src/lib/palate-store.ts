/**
 * Database-backed palate helpers. The pure model lives in src/lib/palate.ts;
 * this module joins it to the DB. Reads recompute from the user's pours so the
 * palate is always fresh (pours can be inserted outside logPour — e.g. seeds),
 * while refreshUserPalate persists the running snapshot onto users.palateProfile
 * to satisfy the "accumulated on the user" model (PLAN.md §4.6).
 */
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import {
  computePalateProfile,
  inferPriceBand,
  type PalateEntry,
  type PalateProfileResult,
  type PriceBand,
} from "@/lib/palate";

/** Pull the user's pours joined with their tasting tags and the bottle profile. */
async function loadPalateEntries(db: DB, userId: string): Promise<PalateEntry[]> {
  const rows = await db
    .select({
      rating: schema.pours.rating,
      createdAt: schema.pours.createdAt,
      flavorTags: schema.tastingNotes.flavorTags,
      bottleProfile: schema.bottles.flavorProfile,
    })
    .from(schema.pours)
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .leftJoin(schema.tastingNotes, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(eq(schema.pours.userId, userId));

  return rows.map((r) => ({
    rating: r.rating,
    flavorTags: r.flavorTags ?? null,
    bottleProfile: r.bottleProfile ?? null,
    createdAt: r.createdAt,
  }));
}

/** The user's current palate, recomputed from their pours as of `now`. */
export async function getUserPalate(
  db: DB,
  userId: string,
  now: Date = new Date(),
): Promise<PalateProfileResult> {
  const entries = await loadPalateEntries(db, userId);
  return computePalateProfile(entries, now);
}

/**
 * Recompute the user's palate and persist the snapshot onto users.palateProfile.
 * Called after a pour is logged or deleted. Best-effort: returns the result so
 * callers can reuse it, and never throws into the caller's happy path beyond a
 * genuine DB failure.
 */
export async function refreshUserPalate(
  db: DB,
  userId: string,
  now: Date = new Date(),
): Promise<PalateProfileResult> {
  const result = await getUserPalate(db, userId, now);
  await db
    .update(schema.user)
    .set({
      palateProfile: {
        vector: result.vector,
        sampleSize: result.sampleSize,
        updatedAt: now.toISOString(),
      },
      updatedAt: now,
    })
    .where(eq(schema.user.id, userId));
  return result;
}

/** Infer the user's price band from the prices they've paid for owned bottles. */
export async function getUserPriceBand(db: DB, userId: string): Promise<PriceBand | null> {
  const rows = await db
    .select({ purchasePrice: schema.userBottles.purchasePrice })
    .from(schema.userBottles)
    .where(and(eq(schema.userBottles.userId, userId), eq(schema.userBottles.relationship, "own")))
    .orderBy(desc(schema.userBottles.purchaseDate));
  return inferPriceBand(rows.map((r) => r.purchasePrice));
}
