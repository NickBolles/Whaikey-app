import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { DB } from "@/db";
import {
  bottles,
  passportTiers,
  pours,
  userBottles,
  type PassportFamily,
  type WhiskeyCategory,
} from "@/db/schema";
import { categoryLabel } from "@/components/category-chip";
import { PASSPORT_TIER_SPECS, tierForCount } from "@/lib/passport-tiers";

export type { PassportFamily } from "@/db/schema";

/**
 * The tier ladder (docs/FEATURES.md §11.4, docs/SOCIAL.md §3.2) lives in
 * src/lib/passport-tiers.ts — pure arithmetic with no DB import, so the badge
 * crests and the discovery rail's progress chip can share it from the client
 * bundle. Re-exported here so server callers keep one import.
 */
export {
  PASSPORT_TIER_SPECS,
  bottlesForTier,
  tierForCount,
  tierSpec,
  type PassportTierSpec,
} from "@/lib/passport-tiers";

export interface PassportBadge {
  family: PassportFamily;
  /** Canonical value as stored on bottles: "Scotland", "Islay", "bourbon". */
  value: string;
  /** Display name ("Bourbon" for style ids; the value itself otherwise). */
  label: string;
  /** Distinct catalog bottles this user has met carrying the stamp. */
  metCount: number;
  /** Distinct verified catalog bottles carrying the stamp (the denominator). */
  catalogTotal: number;
  /** Tier the current counts earn. */
  currentTier: number;
  /** Displayed tier: max of currentTier and every tier ever stamped. */
  heldTier: number;
  /** tier -> when it was first stamped, for the badge history. */
  achievedAt: Partial<Record<number, Date>>;
}

export interface Passport {
  countries: PassportBadge[];
  regions: PassportBadge[];
  styles: PassportBadge[];
}

interface MetBottleRow {
  bottleId: string;
  country: string | null;
  region: string | null;
  category: string;
}

/**
 * Every distinct catalog bottle the user has met: a logged pour OR an
 * own/tried relationship (FEATURES.md §11.2). Wishlist never counts —
 * wanting is not meeting.
 */
async function listMetBottles(db: DB, userId: string): Promise<MetBottleRow[]> {
  const fields = {
    bottleId: bottles.id,
    country: bottles.country,
    region: bottles.region,
    category: bottles.category,
  };
  const [owned, poured] = await Promise.all([
    db
      .select(fields)
      .from(userBottles)
      .innerJoin(bottles, eq(userBottles.bottleId, bottles.id))
      .where(and(eq(userBottles.userId, userId), inArray(userBottles.relationship, ["own", "tried"]))),
    db
      .select(fields)
      .from(pours)
      .innerJoin(bottles, eq(pours.bottleId, bottles.id))
      .where(eq(pours.userId, userId)),
  ]);
  const byId = new Map<string, MetBottleRow>();
  for (const row of [...owned, ...poured]) byId.set(row.bottleId, row);
  return [...byId.values()];
}

/**
 * Denominators: distinct verified bottles per country/region/style. Imported
 * bottles awaiting verification (src/db/schema.ts) stay out — thousands of
 * unvetted label rows would silently deflate everyone's percentages.
 */
async function catalogTotals(db: DB): Promise<Record<PassportFamily, Map<string, number>>> {
  // Grouped in SQL rather than counted in JS: getPassport sits on Home's
  // recommendation path (src/lib/recommend.ts) as well as the profile, and
  // pulling three columns of every verified bottle to tally them here made
  // that an O(catalog) scan per page load.
  const totalsFor = async (column: PgColumn) => {
    const rows = await db
      .select({ value: sql<string | null>`${column}`, count: sql<number>`count(*)` })
      .from(bottles)
      .where(eq(bottles.status, "verified"))
      .groupBy(column);
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row.value) map.set(row.value, Number(row.count));
    }
    return map;
  };
  const [country, region, style] = await Promise.all([
    totalsFor(bottles.country),
    totalsFor(bottles.region),
    totalsFor(bottles.category),
  ]);
  return { country, region, style };
}

function badgeLabel(family: PassportFamily, value: string): string {
  return family === "style" ? categoryLabel(value) : value;
}

/**
 * Compute the user's passport. When `stampNewTiers` is set (the user viewing
 * their own passport), any tier newly cleared is recorded in `passportTiers`
 * with today's date — from then on it can never be lost, however much the
 * catalog grows. Viewing someone else's passport never writes.
 */
export async function getPassport(
  db: DB,
  userId: string,
  opts: { stampNewTiers?: boolean } = {},
): Promise<Passport> {
  const [met, totals, stamped] = await Promise.all([
    listMetBottles(db, userId),
    catalogTotals(db),
    db.select().from(passportTiers).where(eq(passportTiers.userId, userId)),
  ]);

  const metCounts: Record<PassportFamily, Map<string, number>> = {
    country: new Map(),
    region: new Map(),
    style: new Map(),
  };
  const bump = (map: Map<string, number>, value: string | null) => {
    if (value) map.set(value, (map.get(value) ?? 0) + 1);
  };
  for (const row of met) {
    bump(metCounts.country, row.country);
    bump(metCounts.region, row.region);
    bump(metCounts.style, row.category);
  }

  const stampedFor = (family: PassportFamily, value: string) =>
    stamped.filter((s) => s.family === family && s.value === value);

  const build = (family: PassportFamily): PassportBadge[] => {
    // A badge exists once met — or once stamped, so a historic tier survives
    // even if its last bottle were somehow removed from the user's history.
    const values = new Set<string>([
      ...metCounts[family].keys(),
      ...stamped.filter((s) => s.family === family).map((s) => s.value),
    ]);
    const badges = [...values].map((value) => {
      const metCount = metCounts[family].get(value) ?? 0;
      const catalogTotal = totals[family].get(value) ?? 0;
      const currentTier = tierForCount(metCount, catalogTotal);
      const achievedAt: Partial<Record<number, Date>> = {};
      let bestStamped = 0;
      for (const row of stampedFor(family, value)) {
        achievedAt[row.tier] = row.achievedAt;
        bestStamped = Math.max(bestStamped, row.tier);
      }
      return {
        family,
        value,
        label: badgeLabel(family, value),
        metCount,
        catalogTotal,
        currentTier,
        heldTier: Math.max(currentTier, bestStamped),
        achievedAt,
      };
    });
    return badges.sort((a, b) => b.heldTier - a.heldTier || b.metCount - a.metCount || a.label.localeCompare(b.label));
  };

  const passport: Passport = {
    countries: build("country"),
    regions: build("region"),
    styles: build("style"),
  };

  if (opts.stampNewTiers) {
    const newRows: Array<{ id: string; userId: string; family: PassportFamily; value: string; tier: number }> = [];
    for (const badge of [...passport.countries, ...passport.regions, ...passport.styles]) {
      for (const spec of PASSPORT_TIER_SPECS) {
        if (spec.tier <= badge.currentTier && badge.achievedAt[spec.tier] == null) {
          newRows.push({
            id: crypto.randomUUID(),
            userId,
            family: badge.family,
            value: badge.value,
            tier: spec.tier,
          });
        }
      }
    }
    if (newRows.length > 0) {
      const inserted = await db.insert(passportTiers).values(newRows).onConflictDoNothing().returning();
      const now = new Date();
      for (const row of inserted) {
        const list =
          row.family === "country" ? passport.countries : row.family === "region" ? passport.regions : passport.styles;
        const badge = list.find((b) => b.value === row.value);
        if (badge) badge.achievedAt[row.tier] = row.achievedAt ?? now;
      }
    }
  }

  return passport;
}

export interface PassportBadgeDetail {
  badge: PassportBadge;
  /** Every distinct met bottle behind the badge, newest first. */
  bottles: Array<{
    bottleId: string;
    name: string;
    /** Earliest evidence of meeting it: first pour, or when it was shelved. */
    firstMetAt: Date;
    /** Latest rating the user gave it, if any. */
    rating: number | null;
    /** Private to the owner — never rendered for another viewer. */
    pourCount: number;
  }>;
}

/**
 * The owner's drill-down for one badge: which bottles earned it. Only ever
 * called for the signed-in user's own passport — pour counts and dates are
 * private (docs/SOCIAL.md §3.3) and must not be projected to other viewers.
 */
export async function getPassportBadgeDetail(
  db: DB,
  userId: string,
  family: PassportFamily,
  value: string,
): Promise<PassportBadgeDetail | null> {
  const passport = await getPassport(db, userId, { stampNewTiers: true });
  const list = family === "country" ? passport.countries : family === "region" ? passport.regions : passport.styles;
  const badge = list.find((b) => b.value === value);
  if (!badge) return null;

  const valueMatch =
    family === "country"
      ? eq(bottles.country, value)
      : family === "region"
        ? eq(bottles.region, value)
        : eq(bottles.category, value as WhiskeyCategory);
  const fields = { bottleId: bottles.id, name: bottles.name };
  const [owned, poured] = await Promise.all([
    db
      .select({ ...fields, at: userBottles.createdAt })
      .from(userBottles)
      .innerJoin(bottles, eq(userBottles.bottleId, bottles.id))
      .where(and(eq(userBottles.userId, userId), inArray(userBottles.relationship, ["own", "tried"]), valueMatch)),
    db
      .select({ ...fields, at: pours.createdAt, rating: pours.rating })
      .from(pours)
      .innerJoin(bottles, eq(pours.bottleId, bottles.id))
      .where(and(eq(pours.userId, userId), valueMatch)),
  ]);

  const byBottle = new Map<
    string,
    { bottleId: string; name: string; firstMetAt: Date; rating: number | null; pourCount: number; lastPourAt: number }
  >();
  for (const row of owned) {
    const existing = byBottle.get(row.bottleId);
    if (!existing) {
      byBottle.set(row.bottleId, {
        bottleId: row.bottleId,
        name: row.name,
        firstMetAt: row.at,
        rating: null,
        pourCount: 0,
        lastPourAt: 0,
      });
    } else if (row.at < existing.firstMetAt) {
      existing.firstMetAt = row.at;
    }
  }
  for (const row of poured) {
    let entry = byBottle.get(row.bottleId);
    if (!entry) {
      entry = { bottleId: row.bottleId, name: row.name, firstMetAt: row.at, rating: null, pourCount: 0, lastPourAt: 0 };
      byBottle.set(row.bottleId, entry);
    }
    if (row.at < entry.firstMetAt) entry.firstMetAt = row.at;
    entry.pourCount += 1;
    // Latest rating wins — the badge shows where the user landed, not a mean.
    const t = row.at.getTime();
    if (row.rating != null && t >= entry.lastPourAt) {
      entry.rating = row.rating;
      entry.lastPourAt = t;
    }
  }

  return {
    badge,
    bottles: [...byBottle.values()]
      .map(({ bottleId, name, firstMetAt, rating, pourCount }) => ({ bottleId, name, firstMetAt, rating, pourCount }))
      .sort((a, b) => b.firstMetAt.getTime() - a.firstMetAt.getTime()),
  };
}
