import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { SocialDisabledError } from "@/lib/pours";

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
  bottleId: string;
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

/** A row on the "Shared links" management page (`/sharing`). */
export interface PourShareSummary {
  code: string;
  pourId: string;
  bottleId: string;
  bottleName: string;
  createdAt: Date;
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
const NOT_FOUND = Symbol("share-not-found");
const RETRY = Symbol("share-retry");

export async function createPourShare(
  db: DB,
  userId: string,
  pourId: string,
  options: PourShareOptions = {},
): Promise<{ code: string } | null> {
  const locationLabel = cleanLocationLabel(options.locationLabel);

  // Each attempt is one transaction under the same per-user advisory lock
  // makeEverythingPrivate takes, so a share request fully serializes with the
  // US-11 reset — it can never mint or reactivate a link mid-reset. Cross-user
  // code collisions abort the transaction, hence retry-outside-transaction.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = newShareCode();
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`social-reset:${userId}`}))`);

        // US-11: while the owner is stepped back, no new bearer link can be
        // minted (and no revoked one reactivated). SocialDisabledError → 409.
        const profile = await tx.query.userProfiles.findFirst({
          columns: { socialEnabled: true },
          where: eq(schema.userProfiles.userId, userId),
        });
        if (profile && !profile.socialEnabled) throw new SocialDisabledError();

        const existing = await tx.query.pourShares.findFirst({
          where: and(eq(schema.pourShares.pourId, pourId), eq(schema.pourShares.userId, userId)),
        });
        if (existing) {
          if (existing.revokedAt) {
            // A revoked link must never come back to life: re-sharing mints a
            // fresh code on the same row. Conditional on still-revoked so two
            // concurrent re-shares can't have the second overwrite (and kill)
            // the code the first already returned.
            const updated = await tx
              .update(schema.pourShares)
              .set({
                code,
                revokedAt: null,
                ...(options.locationLabel !== undefined ? { locationLabel } : {}),
              })
              .where(
                and(
                  eq(schema.pourShares.id, existing.id),
                  eq(schema.pourShares.userId, userId),
                  isNotNull(schema.pourShares.revokedAt),
                ),
              )
              .returning({ code: schema.pourShares.code });
            if (updated[0]) return updated[0];
            const winner = await tx.query.pourShares.findFirst({
              where: and(eq(schema.pourShares.id, existing.id), eq(schema.pourShares.userId, userId)),
            });
            return winner && !winner.revokedAt ? { code: winner.code } : RETRY;
          }
          if (options.locationLabel !== undefined) {
            await tx
              .update(schema.pourShares)
              .set({ locationLabel })
              .where(and(eq(schema.pourShares.id, existing.id), eq(schema.pourShares.userId, userId)));
          }
          return { code: existing.code };
        }

        const pour = await tx.query.pours.findFirst({
          where: and(eq(schema.pours.id, pourId), eq(schema.pours.userId, userId)),
        });
        if (!pour) return NOT_FOUND;

        const inserted = await tx
          .insert(schema.pourShares)
          .values({ id: crypto.randomUUID(), pourId, userId, code, locationLabel })
          .onConflictDoNothing()
          .returning({ code: schema.pourShares.code });
        if (inserted[0]) return inserted[0];
        const raced = await tx.query.pourShares.findFirst({
          where: and(eq(schema.pourShares.pourId, pourId), eq(schema.pourShares.userId, userId)),
        });
        return raced ? { code: raced.code } : RETRY;
      });
      if (result === NOT_FOUND) return null;
      if (result !== RETRY) return result;
    } catch (err) {
      // Only a code-uniqueness collision earns a retry; anything else is a
      // real database failure that must surface, not read as bad luck.
      if (err instanceof SocialDisabledError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (!/unique|duplicate/i.test(message)) throw err;
    }
  }
  throw new Error("Unable to create a unique pour share link");
}

/** The deliberately limited public projection used by the share page and OG media. */
export async function getPublicPourShare(db: DB, code: string): Promise<PublicPourShare | null> {
  const rows = await db
    .select({
      code: schema.pourShares.code,
      ownerName: schema.user.name,
      bottleId: schema.bottles.id,
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
    // A revoked link must 404 immediately, indistinguishable from a code that
    // never existed.
    .where(and(eq(schema.pourShares.code, code), isNull(schema.pourShares.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    code: row.code,
    ownerName: row.ownerName,
    bottleId: row.bottleId,
    bottleName: row.bottleName,
    locationLabel: row.locationLabel,
    pour: { rating: row.rating, servingStyle: row.servingStyle, amountMl: row.amountMl, createdAt: row.createdAt },
    note: { nose: row.nose, palate: row.palate, finish: row.finish, freeform: row.freeform, flavorTags: row.flavorTags },
  };
}

/**
 * Revokes the caller's own share for a pour (idempotent). Returns false when
 * the pour is missing or not owned by the caller — the same 404 signal
 * `createPourShare` uses — so a share row that never existed is not an error.
 */
export async function revokePourShare(db: DB, userId: string, pourId: string): Promise<boolean> {
  const pour = await db.query.pours.findFirst({
    where: and(eq(schema.pours.id, pourId), eq(schema.pours.userId, userId)),
  });
  if (!pour) return false;

  await db
    .update(schema.pourShares)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.pourShares.pourId, pourId),
        eq(schema.pourShares.userId, userId),
        isNull(schema.pourShares.revokedAt),
      ),
    );
  return true;
}

/** Every active (non-revoked) share the user owns, for the `/sharing` management page. */
export async function listPourShares(db: DB, userId: string): Promise<PourShareSummary[]> {
  return db
    .select({
      code: schema.pourShares.code,
      pourId: schema.pourShares.pourId,
      bottleId: schema.bottles.id,
      bottleName: schema.bottles.name,
      createdAt: schema.pourShares.createdAt,
    })
    .from(schema.pourShares)
    .innerJoin(schema.pours, eq(schema.pourShares.pourId, schema.pours.id))
    .innerJoin(schema.bottles, eq(schema.pours.bottleId, schema.bottles.id))
    .where(and(eq(schema.pourShares.userId, userId), isNull(schema.pourShares.revokedAt)))
    .orderBy(desc(schema.pourShares.createdAt));
}
