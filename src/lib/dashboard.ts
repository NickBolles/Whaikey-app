/**
 * The Home dashboard's month-in-review: what your palate covered, new
 * bottles, palate agreement, the flavor families you reached for, and
 * bottles running low. Pure queries + arithmetic over the user's own data —
 * no AI, so the month sentence is deterministic for the pinned-clock visual
 * suite.
 *
 * Deliberately NOT a consumption scoreboard (AGENTS.md product guardrails,
 * docs/SOCIAL.md §3.1): nothing here counts or compares how much was poured.
 * The month is measured in descriptors named and families explored, which
 * grow by paying attention rather than by drinking more.
 */

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import { getFlavorCalibration } from "@/lib/bar";
import { wedgeForLeaf } from "@/lib/flavor-wheel";

/** A bottle under this fill % is "running low". */
export const RUNNING_LOW_THRESHOLD = 30;

export interface DashboardCategory {
  wedgeId: string;
  /** Share of this month's total tagged intensity, whole percent. */
  sharePct: number;
}

export interface RunningLowRow {
  userBottleId: string;
  bottleId: string;
  name: string;
  fillLevel: number;
}

export interface DashboardData {
  /** e.g. "July" — format upstream. */
  monthName: string;
  prevMonthName: string;
  /** Distinct flavor descriptors named this month — palate breadth, not volume. */
  descriptorsNamed: number;
  /** Distinct bottles those descriptors came from. */
  bottlesNoted: number;
  /** Whether the previous month has tagged notes to compare against. */
  hadPrevMonth: boolean;
  newBottles: number;
  shelfTotal: number;
  /** 0-1 agreement with the label across the whole shelf; null before any comparison. */
  agreement: number | null;
  /** The wedge that rose most vs the previous month (or this month's top, without one). */
  risingWedgeId: string | null;
  topCategories: DashboardCategory[];
  runningLow: RunningLowRow[];
  /**
   * All-time pour count. NEVER rendered — it only gates the greyed skeleton
   * ("is there enough logged to describe a month yet"). Displaying it, or a
   * month-over-month delta of it, would turn the page into the frequency
   * scoreboard the guardrails forbid.
   */
  totalPours: number;
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function prevMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

function monthName(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

interface MonthNotes {
  /** Wedge id -> summed intensity across the month's tagged notes. */
  wedges: Map<string, number>;
  /** Distinct leaf descriptors named. */
  descriptors: Set<string>;
  /** Distinct bottles those notes were written on. */
  bottleIds: Set<string>;
}

/** One user's tagged notes in [from, to), reduced to the shapes the page needs. */
async function monthNotes(db: DB, userId: string, from: Date, to: Date): Promise<MonthNotes> {
  const rows = await db
    .select({ flavorTags: schema.tastingNotes.flavorTags, bottleId: schema.pours.bottleId })
    .from(schema.tastingNotes)
    .innerJoin(schema.pours, eq(schema.tastingNotes.pourId, schema.pours.id))
    .where(
      and(
        eq(schema.pours.userId, userId),
        gte(schema.pours.createdAt, from),
        lt(schema.pours.createdAt, to),
      ),
    );
  const wedges = new Map<string, number>();
  const descriptors = new Set<string>();
  const bottleIds = new Set<string>();
  for (const row of rows) {
    let tagged = false;
    for (const [leafId, intensity] of Object.entries(row.flavorTags ?? {})) {
      const wedgeId = wedgeForLeaf(leafId);
      if (!wedgeId || typeof intensity !== "number") continue;
      wedges.set(wedgeId, (wedges.get(wedgeId) ?? 0) + intensity);
      descriptors.add(leafId);
      tagged = true;
    }
    if (tagged) bottleIds.add(row.bottleId);
  }
  return { wedges, descriptors, bottleIds };
}

export async function getDashboard(db: DB, userId: string, now: Date): Promise<DashboardData> {
  const thisStart = monthStart(now);
  const prevStart = prevMonthStart(now);

  const [
    [totalRow],
    [newBottlesRow],
    [shelfRow],
    thisMonth,
    prevMonth,
    calibration,
    lowRows,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.pours)
      .where(eq(schema.pours.userId, userId)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.userBottles)
      .where(
        and(
          eq(schema.userBottles.userId, userId),
          eq(schema.userBottles.relationship, "own"),
          gte(schema.userBottles.createdAt, thisStart),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)` })
      .from(schema.userBottles)
      .where(and(eq(schema.userBottles.userId, userId), eq(schema.userBottles.relationship, "own"))),
    monthNotes(db, userId, thisStart, now),
    monthNotes(db, userId, prevStart, thisStart),
    getFlavorCalibration(db, userId, "all"),
    db
      .select({
        userBottleId: schema.userBottles.id,
        bottleId: schema.userBottles.bottleId,
        name: schema.bottles.name,
        fillLevel: schema.userBottles.fillLevel,
      })
      .from(schema.userBottles)
      .innerJoin(schema.bottles, eq(schema.userBottles.bottleId, schema.bottles.id))
      .where(
        and(
          eq(schema.userBottles.userId, userId),
          eq(schema.userBottles.relationship, "own"),
          eq(schema.userBottles.status, "open"),
          lt(schema.userBottles.fillLevel, RUNNING_LOW_THRESHOLD),
        ),
      )
      .orderBy(schema.userBottles.fillLevel, desc(schema.userBottles.updatedAt)),
  ]);

  // Shares of this month's tagged intensity, top 3, whole percents.
  const thisTotals = thisMonth.wedges;
  const prevTotals = prevMonth.wedges;
  const thisTotal = [...thisTotals.values()].reduce((a, b) => a + b, 0);
  const topCategories: DashboardCategory[] = [...thisTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([wedgeId, total]) => ({
      wedgeId,
      sharePct: Math.round((total / thisTotal) * 100),
    }));

  // The family that rose the most vs. last month, by share — falls back to
  // this month's top family when last month has nothing to compare against.
  const prevTotal = [...prevTotals.values()].reduce((a, b) => a + b, 0);
  let risingWedgeId: string | null = null;
  if (thisTotal > 0) {
    if (prevTotal > 0) {
      let bestRise = -Infinity;
      for (const [wedgeId, total] of thisTotals) {
        const rise = total / thisTotal - (prevTotals.get(wedgeId) ?? 0) / prevTotal;
        if (rise > bestRise || (rise === bestRise && wedgeId < (risingWedgeId ?? "~"))) {
          bestRise = rise;
          risingWedgeId = wedgeId;
        }
      }
    } else {
      risingWedgeId = topCategories[0]?.wedgeId ?? null;
    }
  }

  return {
    monthName: monthName(now),
    prevMonthName: monthName(prevStart),
    descriptorsNamed: thisMonth.descriptors.size,
    bottlesNoted: thisMonth.bottleIds.size,
    hadPrevMonth: prevTotal > 0,
    newBottles: Number(newBottlesRow?.count ?? 0),
    shelfTotal: Number(shelfRow?.count ?? 0),
    agreement: calibration.hasComparison ? calibration.agreement : null,
    risingWedgeId,
    topCategories,
    runningLow: lowRows.map((row) => ({
      userBottleId: row.userBottleId,
      bottleId: row.bottleId,
      name: row.name,
      fillLevel: row.fillLevel ?? 0,
    })),
    totalPours: Number(totalRow?.count ?? 0),
  };
}
