import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { WEDGE_IDS, wedgeForLeaf } from "@/lib/flavor-wheel";
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
}

export type BarRow = schema.UserBottle & { bottle: BarRowBottle };

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
    })
    .from(schema.userBottles)
    .innerJoin(schema.bottles, eq(schema.userBottles.bottleId, schema.bottles.id))
    .leftJoin(schema.distilleries, eq(schema.bottles.distilleryId, schema.distilleries.id))
    .where(and(...conds))
    .orderBy(desc(schema.userBottles.updatedAt), desc(schema.userBottles.createdAt));

  return rows.map((r) => ({
    ...r.ub,
    bottle: {
      id: r.bottleId,
      name: r.bottleName,
      category: r.category,
      distilleryName: r.distilleryName,
      avgPrice: r.avgPrice,
      flavorProfile: r.flavorProfile,
    },
  }));
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export const KILL_LIST_THRESHOLD = 20;

export interface KillListEntry {
  userBottleId: string;
  bottleId: string;
  bottleName: string;
  fillLevel: number;
}

export interface BarStats {
  bottleCount: number;
  openCount: number;
  sealedCount: number;
  totalSpent: number;
  estValue: number;
  avgBottlePrice: number;
  /** userBottleId -> purchasePrice / max(1, pours logged against that userBottle) */
  costPerPour: Record<string, number>;
  killList: KillListEntry[];
}

export async function getBarStats(db: DB, userId: string): Promise<BarStats> {
  const own = await db
    .select({
      id: schema.userBottles.id,
      bottleId: schema.userBottles.bottleId,
      status: schema.userBottles.status,
      fillLevel: schema.userBottles.fillLevel,
      quantity: schema.userBottles.quantity,
      purchasePrice: schema.userBottles.purchasePrice,
      estValue: schema.userBottles.estValue,
      bottleName: schema.bottles.name,
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
  const killList: KillListEntry[] = [];

  for (const r of own) {
    const qty = r.quantity ?? 1;
    if (r.purchasePrice != null) {
      totalSpent += r.purchasePrice * qty;
      spentQty += qty;
      costPerPour[r.id] = r.purchasePrice / Math.max(1, pourMap.get(r.id) ?? 0);
    }
    const unitValue = r.estValue ?? r.avgPrice;
    if (unitValue != null) estValue += unitValue * qty;
    if (r.status === "open" && r.fillLevel != null && r.fillLevel <= KILL_LIST_THRESHOLD) {
      killList.push({
        userBottleId: r.id,
        bottleId: r.bottleId,
        bottleName: r.bottleName,
        fillLevel: r.fillLevel,
      });
    }
  }

  killList.sort((a, b) => a.fillLevel - b.fillLevel);

  return {
    bottleCount: own.length,
    openCount: own.filter((r) => r.status === "open").length,
    sealedCount: own.filter((r) => r.status === "sealed").length,
    totalSpent,
    estValue,
    avgBottlePrice: spentQty > 0 ? totalSpent / spentQty : 0,
    costPerPour,
    killList,
  };
}

// ---------------------------------------------------------------------------
// Bar flavor heat (the "bar palate" heat map)
// ---------------------------------------------------------------------------

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
 * Aggregate where a user's bar leans on the flavor wheel. Wedge heat sums the
 * flavor profiles (0-10 per wedge) of owned bottles; the user's tasting-note
 * flavor tags (1-3 per leaf) add leaf heat and warm their parent wedge, so
 * pours on tried bottles count too. Both maps are normalized to their own
 * max — heat is relative ("where does MY bar lean"), never an absolute score.
 */
export async function getBarFlavorHeat(db: DB, userId: string): Promise<BarFlavorHeat> {
  const validWedges = new Set<string>(WEDGE_IDS);
  const wedgeTotals: Record<string, number> = {};
  const leafTotals: Record<string, number> = {};

  const owned = await db
    .select({ flavorProfile: schema.bottles.flavorProfile })
    .from(schema.userBottles)
    .innerJoin(schema.bottles, eq(schema.userBottles.bottleId, schema.bottles.id))
    .where(and(eq(schema.userBottles.userId, userId), eq(schema.userBottles.relationship, "own")));

  for (const row of owned) {
    if (!row.flavorProfile) continue;
    for (const [wedgeId, score] of Object.entries(row.flavorProfile)) {
      if (!validWedges.has(wedgeId) || typeof score !== "number") continue;
      wedgeTotals[wedgeId] = (wedgeTotals[wedgeId] ?? 0) + Math.max(0, score);
    }
  }

  const notes = await db
    .select({ flavorTags: schema.tastingNotes.flavorTags })
    .from(schema.tastingNotes)
    .innerJoin(schema.pours, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(eq(schema.pours.userId, userId));

  for (const note of notes) {
    if (!note.flavorTags) continue;
    for (const [leafId, intensity] of Object.entries(note.flavorTags)) {
      const wedgeId = wedgeForLeaf(leafId);
      if (!wedgeId || typeof intensity !== "number") continue;
      leafTotals[leafId] = (leafTotals[leafId] ?? 0) + intensity;
      wedgeTotals[wedgeId] = (wedgeTotals[wedgeId] ?? 0) + intensity;
    }
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
