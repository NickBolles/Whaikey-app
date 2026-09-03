import { and, desc, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { POUR_VISIBILITIES, SERVING_STYLES, type Pour, type PourVisibility, type TastingNote } from "@/db/schema";
import { canViewBottle } from "@/lib/catalog-visibility";
import { isValidLeaf } from "@/lib/flavor-wheel";
import { refreshUserPalate } from "@/lib/palate-store";
import { getSocialPrefs } from "@/lib/social";

/** Standard pour when the user doesn't specify an amount. */
export const DEFAULT_POUR_ML = 45;

/** docs/SOCIAL.md §11: cap on cross-user-visible pour writes per hour; past it, pours still log — as private. */
export const VISIBLE_POUR_LIMIT_PER_HOUR = 30;

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
  visibility: z.enum(POUR_VISIBILITIES).optional(),
  /**
   * Idempotency key minted by the client before its first send attempt and
   * reused by every retry of that same pour (REL-4.2). Opaque to the server —
   * it only ever has to be stable and unguessable-per-user, and it is scoped
   * to the user, so one client cannot collide with another's.
   */
  clientId: z.string().min(1).max(100).optional(),
  /**
   * Who the client believes it is writing as. The server refuses the write if
   * that isn't the session making it.
   *
   * The offline queue picks entries by an author it captured when the page
   * rendered, but `fetch` carries whatever cookie is current — so an account
   * switch part-way through a multi-entry flush would post the rest of one
   * person's pours into the other's account. Client-side care cannot close
   * that race; refusing the write can, and it holds for the direct save too.
   */
  expectedUserId: z.string().min(1).max(100).optional(),
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

/** Uses column-aware operators so Postgres receives an encoded timestamp string. */
export function visiblePourRateLimitCondition(userId: string, since: Date) {
  return and(
    eq(schema.pours.userId, userId),
    ne(schema.pours.visibility, "private"),
    gt(schema.pours.createdAt, since),
  );
}

/**
 * Log a pour for a user. Validates input (throws ZodError on bad shape /
 * flavor tags), throws BottleNotFoundError for unknown bottles. The pour is
 * linked to the user's shelf row for that bottle, creating a "tried" row when
 * none exists, and when that row is an "open" bottle with a fill level, the
 * fill is decremented ~3% per 30ml poured (floored at 0). An optional tasting
 * note is stored 1:1 with the pour. Visibility is `input.visibility` when
 * given, else the user's `defaultPourVisibility` social pref, else "private".
 *
 * When `input.clientId` is present the write is idempotent: a replay returns
 * the pour the first attempt created, unchanged, and logs nothing new. That is
 * what makes the offline queue safe to retry — a flush whose 201 never made it
 * back to the device would otherwise log the dram twice and take the fill
 * level down twice with it.
 */
export async function logPour(db: DB, userId: string, input: PourInput): Promise<LoggedPour> {
  const parsed = pourInputSchema.parse(input);

  const bottle = await db.query.bottles.findFirst({
    where: eq(schema.bottles.id, parsed.bottleId),
  });
  // Unknown and "somebody else's unreviewed submission" are the same answer
  // here (PLAN-A1): a pour can only be logged against a bottle the user can see.
  if (!bottle || !canViewBottle(bottle, userId)) throw new BottleNotFoundError(parsed.bottleId);

  const amountMl = parsed.amountMl ?? DEFAULT_POUR_ML;
  let visibility: PourVisibility =
    parsed.visibility ?? (await getSocialPrefs(db, userId)).defaultPourVisibility;

  /**
   * A pour of a bottle nobody has reviewed is private, whatever was asked for
   * (PLAN-A1/WP-16).
   *
   * The submission is visible to its submitter alone, but a pour of it is not
   * only a pour: the friend feed, a shared note and a profile's recent notes
   * all join the bottle for its name, and none of them checks its status. So
   * a public pour of a pending bottle would publish the bottle through the
   * side door — the one thing the submission rule exists to prevent.
   *
   * Held down rather than filtered on read: this is one place instead of every
   * social projection, and it fails closed. It also stays honest about the
   * stance — the system never *raises* a visibility, so when the bottle is
   * promoted the note stays where it is until its owner chooses otherwise.
   */
  if (bottle.status === "user_submitted") visibility = "private";
  const { pour, note } = await db.transaction(async (tx) => {
    if (parsed.clientId) {
      // Serialize replays of the same key so two in-flight retries can't both
      // read "no pour yet" and both insert. The unique index on
      // (user_id, client_id) is the backstop if they ever do.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`pour-idem:${userId}:${parsed.clientId}`}))`,
      );
      const existing = await tx.query.pours.findFirst({
        where: and(eq(schema.pours.userId, userId), eq(schema.pours.clientId, parsed.clientId)),
      });
      if (existing) {
        const existingNote = await tx.query.tastingNotes.findFirst({
          where: eq(schema.tastingNotes.pourId, existing.id),
        });
        return { pour: existing, note: existingNote ?? null };
      }
    }
    if (visibility !== "private") {
      // Everything below runs under the same per-user advisory lock as
      // makeEverythingPrivate, so a visible write can't slip past a
      // concurrent US-11 reset and land after it with stale visibility.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`social-reset:${userId}`}))`);

      // A stepped-back user's new pours are always private, even when the
      // write carries an explicit visibility — an offline-queued pour minted
      // before "make everything private" must not resurface as visible on
      // replay (US-11). Re-enabling social restores nothing implicitly.
      const profile = await tx.query.userProfiles.findFirst({
        columns: { socialEnabled: true },
        where: eq(schema.userProfiles.userId, userId),
      });
      if (profile && !profile.socialEnabled) visibility = "private";
    }
    if (visibility !== "private") {
      // docs/SOCIAL.md §11: notes are user-generated text and cross-user
      // writes are rate-limited. Logging itself must never block (the private
      // journal is the core loop), so past the cap the pour still lands — as
      // private. Counting inside the locked transaction means concurrent
      // requests can't all read a below-limit count before any commits.
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const recentVisible = await tx
        .select({ n: sql<number>`count(*)` })
        .from(schema.pours)
        .where(visiblePourRateLimitCondition(userId, hourAgo));
      if (Number(recentVisible[0]?.n ?? 0) >= VISIBLE_POUR_LIMIT_PER_HOUR) visibility = "private";
    }
    let userBottle = await tx.query.userBottles.findFirst({
      where: and(eq(schema.userBottles.userId, userId), eq(schema.userBottles.bottleId, parsed.bottleId)),
    });
    // Pouring something is proof you tried it. Without a shelf row the bottle
    // is invisible to the Tried tab and to every flavor map, so record the
    // weakest relationship that is unambiguously true. Existing rows are left
    // alone — this never promotes or demotes a bottle you already filed.
    if (!userBottle) {
      [userBottle] = await tx
        .insert(schema.userBottles)
        .values({
          id: crypto.randomUUID(),
          userId,
          bottleId: parsed.bottleId,
          relationship: "tried",
        })
        .returning();
    }
    const [pour] = await tx
      .insert(schema.pours)
      .values({
        id: crypto.randomUUID(), userId, bottleId: parsed.bottleId, userBottleId: userBottle?.id ?? null,
        rating: parsed.rating ?? null, servingStyle: parsed.servingStyle ?? null, amountMl, context: parsed.context ?? null,
        visibility, clientId: parsed.clientId ?? null,
      })
      .returning();
    if (userBottle?.status === "open" && userBottle.fillLevel != null) {
      await tx.update(schema.userBottles).set({
        fillLevel: sql`greatest(0, ${schema.userBottles.fillLevel} - ${fillDecrementFor(amountMl)})`, updatedAt: new Date(),
      }).where(and(eq(schema.userBottles.id, userBottle.id), eq(schema.userBottles.status, "open"), isNotNull(schema.userBottles.fillLevel)));
    }
    let note: TastingNote | null = null;
    if (parsed.note && noteHasContent(parsed.note)) {
      const [inserted] = await tx
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
    // The materialized palate is part of this write: a failed refresh must
    // roll back the pour, note, and fill-level decrement together.
    await refreshUserPalate(tx as DB, userId);
    return { pour, note };
  });

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

export class SocialDisabledError extends Error {
  constructor() {
    super("Social is turned off");
    this.name = "SocialDisabledError";
  }
}

/**
 * Raised when a pour of an unreviewed submission is asked to become visible.
 * The bottle is its submitter's alone until somebody reviews it, and a public
 * pour would publish it through the side door.
 */
export class PendingBottleError extends Error {
  constructor() {
    super("That bottle is still waiting to be reviewed");
    this.name = "PendingBottleError";
  }
}

/**
 * Update a pour's social visibility. Owner-scoped; returns null for
 * missing/others'. While the owner is stepped back (socialEnabled=false),
 * non-private updates are rejected — otherwise a stale History tab could
 * re-expose a pour that "make everything private" just hid, with the change
 * surfacing only when social is re-enabled (docs/SOCIAL.md US-11).
 */
export async function updatePourVisibility(
  db: DB,
  userId: string,
  pourId: string,
  visibility: PourVisibility,
): Promise<Pour | null> {
  return db.transaction(async (tx) => {
    if (visibility !== "private") {
      /**
       * A pour of a bottle nobody has reviewed cannot be published later
       * either (PLAN-A1/WP-16). `logPour` holds it private at write time; this
       * is the other door into the same room, and a public projection here
       * would carry the pending bottle's name into the feed just the same.
       */
      const [row] = await tx
        .select({ status: schema.bottles.status })
        .from(schema.pours)
        .innerJoin(schema.bottles, eq(schema.bottles.id, schema.pours.bottleId))
        .where(and(eq(schema.pours.id, pourId), eq(schema.pours.userId, userId)))
        .limit(1);
      if (row?.status === "user_submitted") throw new PendingBottleError();
    }
    if (visibility !== "private") {
      // Same lock as makeEverythingPrivate: the check and the write are
      // atomic w.r.t. a concurrent US-11 reset.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`social-reset:${userId}`}))`);
      const profile = await tx.query.userProfiles.findFirst({
        columns: { socialEnabled: true },
        where: eq(schema.userProfiles.userId, userId),
      });
      if (profile && !profile.socialEnabled) throw new SocialDisabledError();
    }
    const rows = await tx
      .update(schema.pours)
      .set({ visibility })
      .where(and(eq(schema.pours.id, pourId), eq(schema.pours.userId, userId)))
      .returning();
    return rows[0] ?? null;
  });
}

/** Delete a pour (tasting note cascades). Returns false for missing/others'. */
export async function deletePour(db: DB, userId: string, pourId: string): Promise<boolean> {
  const deleted = await db
    .delete(schema.pours)
    .where(and(eq(schema.pours.id, pourId), eq(schema.pours.userId, userId)))
    .returning({ id: schema.pours.id });
  if (deleted.length > 0) {
    // Removing a pour changes the palate; keep the snapshot in sync.
    await refreshUserPalate(db, userId);
  }
  return deleted.length > 0;
}
