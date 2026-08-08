import { and, desc, eq, exists, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { WEDGE_IDS, rollUpToWedges, wedgeForLeaf } from "@/lib/flavor-wheel";
import {
  BOTTLE_STATUSES,
  RELATIONSHIPS,
  type BottleStatus,
  type Relationship,
  type WhiskeyCategory,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// Validation schemas (shared by the /api/user-bottles routes)
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "Invalid ISO date string" });

const editableFields = {
  status: z.enum(BOTTLE_STATUSES).optional(),
  fillLevel: z.number().int().min(0).max(100).nullish(),
  quantity: z.number().int().min(1).optional(),
  purchasePrice: z.number().min(0).nullish(),
  purchaseDate: isoDate.nullish(),
  store: z.string().max(200).nullish(),
  estValue: z.number().min(0).nullish(),
  location: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
};

export const userBottleCreateSchema = z.object({
  bottleId: z.string().min(1),
  relationship: z.enum(RELATIONSHIPS),
  ...editableFields,
});

export const userBottleUpdateSchema = z.object({
  relationship: z.enum(RELATIONSHIPS).optional(),
  ...editableFields,
});

export type UserBottleCreateInput = z.infer<typeof userBottleCreateSchema>;
export type UserBottleUpdateInput = z.infer<typeof userBottleUpdateSchema>;

/**
 * Map a validated input payload onto userBottles column values, only including
 * fields the caller actually provided (undefined = untouched, null = clear).
 */
export function toUserBottleValues(
  input: Omit<Partial<UserBottleCreateInput>, "bottleId" | "relationship">,
): Partial<typeof schema.userBottles.$inferInsert> {
  const out: Partial<typeof schema.userBottles.$inferInsert> = {};
  if (input.status !== undefined) out.status = input.status;
  if (input.fillLevel !== undefined) out.fillLevel = input.fillLevel;
  if (input.quantity !== undefined) out.quantity = input.quantity;
  if (input.purchasePrice !== undefined) out.purchasePrice = input.purchasePrice;
  if (input.purchaseDate !== undefined)
    out.purchaseDate = input.purchaseDate == null ? null : new Date(input.purchaseDate);
  if (input.store !== undefined) out.store = input.store;
  if (input.estValue !== undefined) out.estValue = input.estValue;
  if (input.location !== undefined) out.location = input.location;
  if (input.notes !== undefined) out.notes = input.notes;
  return out;
}

// ---------------------------------------------------------------------------
// Add / update a shelf row (shared by /api/user-bottles and the scan flow)
// ---------------------------------------------------------------------------

/**
 * Upsert by (userId, bottleId): inserts with own-defaults (sealed, full, one
 * bottle), or updates the existing row's relationship + provided fields.
 */
export async function upsertUserBottle(
  db: DB,
  userId: string,
  input: UserBottleCreateInput,
): Promise<{ row: schema.UserBottle; created: boolean }> {
  const values = toUserBottleValues(input);
  const existing = await db.query.userBottles.findFirst({
    where: and(
      eq(schema.userBottles.userId, userId),
      eq(schema.userBottles.bottleId, input.bottleId),
    ),
  });

  if (existing) {
    const [row] = await db
      .update(schema.userBottles)
      .set({ relationship: input.relationship, ...values, updatedAt: new Date() })
      .where(eq(schema.userBottles.id, existing.id))
      .returning();
    return { row, created: false };
  }

  const ownDefaults =
    input.relationship === "own"
      ? { status: "sealed" as BottleStatus, fillLevel: 100, quantity: 1 }
      : {};
  const [row] = await db
    .insert(schema.userBottles)
    .values({
      id: crypto.randomUUID(),
      userId,
      bottleId: input.bottleId,
      relationship: input.relationship,
      ...ownDefaults,
      ...values,
    })
    .returning();
  return { row, created: true };
}

// ---------------------------------------------------------------------------
// Inventory queries
// ---------------------------------------------------------------------------

export interface BarRowBottle {
  id: string;
  name: string;
  category: WhiskeyCategory;
  distilleryName: string | null;
  avgPrice: number | null;
  flavorProfile: Record<string, number> | null;
  producerFlavorTags: Record<string, number> | null;
  producerFlavorSourceUrl: string | null;
  producerFlavorSourceLabel: string | null;
}

/** A producer claim is only displayable when it carries source attribution. */
export function hasPublishedProducerFlavorNotes(bottle: Pick<BarRowBottle, "producerFlavorTags" | "producerFlavorSourceUrl" | "producerFlavorSourceLabel">): boolean {
  return (
    bottle.producerFlavorTags != null &&
    Boolean(bottle.producerFlavorSourceUrl?.trim()) &&
    Boolean(bottle.producerFlavorSourceLabel?.trim())
  );
}

/** Personal note tags rolled up per bottle for client-side wheel filtering. */
export type BarRow = schema.UserBottle & {
  bottle: BarRowBottle;
  personalFlavorTags: Record<string, number>;
};

export async function listUserBottles(
  db: DB,
  userId: string,
  filters: { relationship?: Relationship; status?: BottleStatus } = {},
): Promise<BarRow[]> {
  const conds = [eq(schema.userBottles.userId, userId)];
  if (filters.relationship) conds.push(eq(schema.userBottles.relationship, filters.relationship));
  if (filters.status) conds.push(eq(schema.userBottles.status, filters.status));

  const rows = await db
    .select({
      ub: schema.userBottles,
      bottleId: schema.bottles.id,
      bottleName: schema.bottles.name,
      category: schema.bottles.category,
      distilleryName: schema.distilleries.name,
      avgPrice: schema.bottles.avgPrice,
      flavorProfile: schema.bottles.flavorProfile,
      producerFlavorTags: schema.bottles.producerFlavorTags,
      producerFlavorSourceUrl: schema.bottles.producerFlavorSourceUrl,
      producerFlavorSourceLabel: schema.bottles.producerFlavorSourceLabel,
    })
    .from(schema.userBottles)
    .innerJoin(schema.bottles, eq(schema.userBottles.bottleId, schema.bottles.id))
    .leftJoin(schema.distilleries, eq(schema.bottles.distilleryId, schema.distilleries.id))
    .where(and(...conds))
    .orderBy(desc(schema.userBottles.updatedAt), desc(schema.userBottles.createdAt));

  const personalTags = await db
    .select({ bottleId: schema.pours.bottleId, flavorTags: schema.tastingNotes.flavorTags })
    .from(schema.tastingNotes)
    .innerJoin(schema.pours, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(eq(schema.pours.userId, userId));
  const personalTagsByBottle = new Map<string, Record<string, number>>();
  for (const row of personalTags) {
    if (!row.flavorTags) continue;
    const tags = personalTagsByBottle.get(row.bottleId) ?? {};
    for (const [leafId, intensity] of Object.entries(row.flavorTags)) {
      if (wedgeForLeaf(leafId) && typeof intensity === "number") {
        tags[leafId] = (tags[leafId] ?? 0) + intensity;
      }
    }
    personalTagsByBottle.set(row.bottleId, tags);
  }

  return rows.map((r) => ({
    ...r.ub,
    personalFlavorTags: personalTagsByBottle.get(r.bottleId) ?? {},
    bottle: {
      id: r.bottleId,
      name: r.bottleName,
      category: r.category,
      distilleryName: r.distilleryName,
      avgPrice: r.avgPrice,
      flavorProfile: r.flavorProfile,
      producerFlavorTags: r.producerFlavorTags,
      producerFlavorSourceUrl: r.producerFlavorSourceUrl,
      producerFlavorSourceLabel: r.producerFlavorSourceLabel,
    },
  }));
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface BarStats {
  bottleCount: number;
  openCount: number;
  sealedCount: number;
  totalSpent: number;
  estValue: number;
  avgBottlePrice: number;
  /** userBottleId -> purchasePrice / max(1, pours logged against that userBottle) */
  costPerPour: Record<string, number>;
}

export async function getBarStats(db: DB, userId: string): Promise<BarStats> {
  const own = await db
    .select({
      id: schema.userBottles.id,
      status: schema.userBottles.status,
      quantity: schema.userBottles.quantity,
      purchasePrice: schema.userBottles.purchasePrice,
      estValue: schema.userBottles.estValue,
      avgPrice: schema.bottles.avgPrice,
    })
    .from(schema.userBottles)
    .innerJoin(schema.bottles, eq(schema.userBottles.bottleId, schema.bottles.id))
    .where(and(eq(schema.userBottles.userId, userId), eq(schema.userBottles.relationship, "own")));

  const pourCounts = await db
    .select({ userBottleId: schema.pours.userBottleId, n: sql<number>`count(*)` })
    .from(schema.pours)
    .where(and(eq(schema.pours.userId, userId), isNotNull(schema.pours.userBottleId)))
    .groupBy(schema.pours.userBottleId);
  const pourMap = new Map(pourCounts.map((p) => [p.userBottleId as string, p.n]));

  let totalSpent = 0;
  let estValue = 0;
  let spentQty = 0;
  const costPerPour: Record<string, number> = {};

  for (const r of own) {
    const qty = r.quantity ?? 1;
    if (r.purchasePrice != null) {
      totalSpent += r.purchasePrice * qty;
      spentQty += qty;
      costPerPour[r.id] = r.purchasePrice / Math.max(1, pourMap.get(r.id) ?? 0);
    }
    const unitValue = r.estValue ?? r.avgPrice;
    if (unitValue != null) estValue += unitValue * qty;
  }

  return {
    bottleCount: own.length,
    openCount: own.filter((r) => r.status === "open").length,
    sealedCount: own.filter((r) => r.status === "sealed").length,
    totalSpent,
    estValue,
    avgBottlePrice: spentQty > 0 ? totalSpent / spentQty : 0,
    costPerPour,
  };
}

// ---------------------------------------------------------------------------
// Bar flavor heat (the "bar palate" heat map)
// ---------------------------------------------------------------------------

export type FlavorHeatSource = "combined" | "personal" | "producer";

/**
 * Which shelf a flavor map describes. Wishlist bottles are never included in
 * any scope: you have not tasted them, so their profiles would describe an
 * aspiration rather than a palate.
 */
export type FlavorHeatScope = "own" | "tried" | "all";

export const FLAVOR_HEAT_SCOPES = ["own", "tried", "all"] as const satisfies readonly FlavorHeatScope[];

const SCOPE_RELATIONSHIPS: Record<FlavorHeatScope, Relationship[]> = {
  own: ["own"],
  tried: ["tried"],
  all: ["own", "tried"],
};

export interface BarFlavorHeat {
  /** Wedge id -> 0-1, relative to the hottest wedge. */
  wedges: Record<string, number>;
  /** Leaf id -> 0-1, relative to the hottest leaf. */
  leaves: Record<string, number>;
  /** Wedge ids with heat > 0, hottest first. */
  topWedgeIds: string[];
  hasHeat: boolean;
}

/**
 * Aggregate where a user's whiskey leans on the flavor wheel. Wedge heat sums
 * the flavor profiles (0-10 per wedge) of the in-scope bottles; the user's
 * tasting-note flavor tags add leaf heat and warm their parent wedge. Both maps
 * are normalized to their own max — heat is relative ("where does this shelf
 * lean"), never an absolute score.
 *
 * `scope` chooses the shelf: bottles you own, bottles you have only tried, or
 * everything you have tasted. It bounds both halves of the calculation, so the
 * wheel always describes exactly the rows the caller is showing beside it.
 *
 * Two things keep the wheel's inner and outer rings telling the same story:
 * note tags are rolled up through `rollUpToWedges` so a pour lands on the same
 * 0-10 scale a bottle profile uses (raw 1-3 intensities would be worth ~a tenth
 * of a bottle and never register), and a wedge is floored at its own hottest
 * leaf so the wheel can never paint a blazing leaf inside a cold family.
 */
export async function getBarFlavorHeat(
  db: DB,
  userId: string,
  source: FlavorHeatSource = "combined",
  scope: FlavorHeatScope = "all",
): Promise<BarFlavorHeat> {
  const validWedges = new Set<string>(WEDGE_IDS);
  const wedgeTotals: Record<string, number> = {};
  const leafTotals: Record<string, number> = {};
  const inScope = inArray(schema.userBottles.relationship, SCOPE_RELATIONSHIPS[scope]);

  const addTags = (flavorTags: Record<string, number> | null) => {
    if (!flavorTags) return;
    const tags: Record<string, number> = {};
    for (const [leafId, intensity] of Object.entries(flavorTags)) {
      if (!wedgeForLeaf(leafId) || typeof intensity !== "number") continue;
      leafTotals[leafId] = (leafTotals[leafId] ?? 0) + intensity;
      tags[leafId] = intensity;
    }
    for (const [wedgeId, score] of Object.entries(rollUpToWedges(tags))) {
      wedgeTotals[wedgeId] = (wedgeTotals[wedgeId] ?? 0) + score;
    }
  };

  const shelf = await db
    .select({
      flavorProfile: schema.bottles.flavorProfile,
      producerFlavorTags: schema.bottles.producerFlavorTags,
      producerFlavorSourceUrl: schema.bottles.producerFlavorSourceUrl,
      producerFlavorSourceLabel: schema.bottles.producerFlavorSourceLabel,
    })
    .from(schema.userBottles)
    .innerJoin(schema.bottles, eq(schema.userBottles.bottleId, schema.bottles.id))
    .where(and(eq(schema.userBottles.userId, userId), inScope));

  for (const row of shelf) {
    // Catalog wedge profiles fill the wheel even before personal descriptors
    // are logged. They are estimates, not producer claims, so never use them in
    // the Producer Notes source.
    if (source !== "producer" && row.flavorProfile) {
      for (const [wedgeId, score] of Object.entries(row.flavorProfile)) {
        if (!validWedges.has(wedgeId) || typeof score !== "number") continue;
        wedgeTotals[wedgeId] = (wedgeTotals[wedgeId] ?? 0) + Math.max(0, score);
      }
    }
    if (source === "producer" && hasPublishedProducerFlavorNotes(row)) {
      addTags(row.producerFlavorTags);
    }
  }

  if (source === "combined" || source === "personal") {
    const notes = await db
      .select({ flavorTags: schema.tastingNotes.flavorTags })
      .from(schema.tastingNotes)
      .innerJoin(schema.pours, eq(schema.tastingNotes.pourId, schema.pours.id))
      .where(
        and(
          eq(schema.pours.userId, userId),
          exists(
            db
              .select({ id: schema.userBottles.id })
              .from(schema.userBottles)
              .where(
                and(
                  eq(schema.userBottles.userId, userId),
                  eq(schema.userBottles.bottleId, schema.pours.bottleId),
                  inScope,
                ),
              ),
          ),
        ),
      );
    for (const note of notes) addTags(note.flavorTags);
  }

  const normalize = (totals: Record<string, number>): Record<string, number> => {
    const max = Math.max(0, ...Object.values(totals));
    if (max === 0) return {};
    const out: Record<string, number> = {};
    for (const [id, total] of Object.entries(totals)) {
      if (total > 0) out[id] = Math.round((total / max) * 100) / 100;
    }
    return out;
  };

  const wedges = normalize(wedgeTotals);
  const leaves = normalize(leafTotals);

  // A family is never colder than its own hottest flavor: the two rings are
  // normalized against different denominators, and without this floor the
  // brightest leaf on the wheel can sit inside a barely-lit wedge.
  for (const [leafId, heat] of Object.entries(leaves)) {
    const wedgeId = wedgeForLeaf(leafId);
    if (!wedgeId) continue;
    if (heat > (wedges[wedgeId] ?? 0)) wedges[wedgeId] = heat;
  }

  const topWedgeIds = Object.entries(wedges)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  return { wedges, leaves, topWedgeIds, hasHeat: topWedgeIds.length > 0 };
}

// ---------------------------------------------------------------------------
// Spend by month (last 12 months, UTC buckets, zero-filled)
// ---------------------------------------------------------------------------

export interface MonthSpend {
  /** "YYYY-MM" (UTC) */
  month: string;
  total: number;
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getSpendByMonth(
  db: DB,
  userId: string,
  now: Date = new Date(),
): Promise<MonthSpend[]> {
  const months: MonthSpend[] = [];
  const index = new Map<string, MonthSpend>();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const entry = { month: monthKey(d), total: 0 };
    months.push(entry);
    index.set(entry.month, entry);
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const rows = await db
    .select({
      purchasePrice: schema.userBottles.purchasePrice,
      quantity: schema.userBottles.quantity,
      purchaseDate: schema.userBottles.purchaseDate,
    })
    .from(schema.userBottles)
    .where(
      and(
        eq(schema.userBottles.userId, userId),
        eq(schema.userBottles.relationship, "own"),
        isNotNull(schema.userBottles.purchasePrice),
        isNotNull(schema.userBottles.purchaseDate),
        gte(schema.userBottles.purchaseDate, start),
      ),
    );

  for (const r of rows) {
    if (r.purchaseDate == null || r.purchasePrice == null) continue;
    const entry = index.get(monthKey(r.purchaseDate));
    if (entry) entry.total += r.purchasePrice * (r.quantity ?? 1);
  }
  return months;
}
