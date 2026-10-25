import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { DB } from "@/db";
import * as schema from "@/db/schema";
import { leafLabel } from "@/lib/flavor-wheel";
import { getTasteTwins } from "@/lib/taste-twins";

/**
 * Whaikey Wrapped — the year in review (docs/SOCIAL.md §7.14, D19; design
 * board P2). Breadth-framed only: what was *discovered* — countries, regions,
 * distilleries, styles and descriptors met for the first time this year — the
 * best new find, and a taste twin. No count of pours, nights, millilitres or
 * money appears anywhere, by construction: nothing below reads those columns.
 *
 * Private by default. Opens on December 10 for the current year (any earlier
 * year is always available); sharing is a card the person chooses to make.
 */

export const WRAPPED_OPENS = { month: 11, day: 10 } as const; // December 10 (0-based month)

export function wrappedAvailable(year: number, now: Date): boolean {
  const y = now.getUTCFullYear();
  if (year < 2020 || year > y) return false;
  if (year < y) return true;
  return now >= new Date(Date.UTC(y, WRAPPED_OPENS.month, WRAPPED_OPENS.day));
}

export interface Wrapped {
  year: number;
  discovered: {
    countries: string[];
    regions: string[];
    distilleries: number;
    styles: string[];
  };
  descriptors: string[];
  bestNewFind: { bottleId: string; name: string; rating: number } | null;
  tasteTwin: { handle: string; matchPercent: number } | null;
  /** True when there is nothing to show — the page says so instead of zeros. */
  empty: boolean;
}

interface Met {
  bottleId: string;
  at: Date;
  name: string;
  country: string | null;
  region: string | null;
  distilleryId: string | null;
  category: string;
}

async function metEvents(db: DB, userId: string, before: Date): Promise<Met[]> {
  const cols = {
    bottleId: schema.bottles.id,
    name: schema.bottles.name,
    country: schema.bottles.country,
    region: schema.bottles.region,
    distilleryId: schema.bottles.distilleryId,
    category: schema.bottles.category,
  };
  const [poured, shelved] = await Promise.all([
    db
      .select({ ...cols, at: schema.pours.createdAt })
      .from(schema.pours)
      .innerJoin(schema.bottles, eq(schema.bottles.id, schema.pours.bottleId))
      .where(and(eq(schema.pours.userId, userId), lt(schema.pours.createdAt, before), ne(schema.bottles.status, "user_submitted"))),
    db
      .select({ ...cols, at: schema.userBottles.createdAt })
      .from(schema.userBottles)
      .innerJoin(schema.bottles, eq(schema.bottles.id, schema.userBottles.bottleId))
      .where(
        and(
          eq(schema.userBottles.userId, userId),
          inArray(schema.userBottles.relationship, ["own", "tried"]),
          lt(schema.userBottles.createdAt, before),
          ne(schema.bottles.status, "user_submitted"),
        ),
      ),
  ]);
  return [...poured, ...shelved];
}

/** Keys whose first appearance falls inside [start, end). */
function firstMetIn<T>(events: Met[], key: (m: Met) => T | null, start: Date): Set<T> {
  const first = new Map<T, Date>();
  for (const e of events) {
    const k = key(e);
    if (k == null) continue;
    const prev = first.get(k);
    if (!prev || e.at < prev) first.set(k, e.at);
  }
  return new Set([...first.entries()].filter(([, at]) => at >= start).map(([k]) => k));
}

export async function getWrapped(db: DB, userId: string, year: number): Promise<Wrapped> {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const events = await metEvents(db, userId, end);
  const countries = [...firstMetIn(events, (e) => e.country, start)].sort();
  const regions = [...firstMetIn(events, (e) => e.region, start)].sort();
  const distilleries = firstMetIn(events, (e) => e.distilleryId, start).size;
  const styles = [...firstMetIn(events, (e) => e.category, start)].sort();
  const newBottles = firstMetIn(events, (e) => e.bottleId, start);

  const noteRows = await db
    .select({ flavorTags: schema.tastingNotes.flavorTags })
    .from(schema.tastingNotes)
    .innerJoin(schema.pours, eq(schema.pours.id, schema.tastingNotes.pourId))
    .where(and(eq(schema.pours.userId, userId), gte(schema.pours.createdAt, start), lt(schema.pours.createdAt, end)));
  const descriptors = [...new Set(noteRows.flatMap((r) => Object.keys(r.flavorTags ?? {})))]
    .map((id) => leafLabel(id))
    .filter((l): l is string => Boolean(l))
    .sort();

  let bestNewFind: Wrapped["bestNewFind"] = null;
  if (newBottles.size > 0) {
    const rated = await db
      .select({ bottleId: schema.pours.bottleId, rating: schema.pours.rating, at: schema.pours.createdAt, name: schema.bottles.name })
      .from(schema.pours)
      .innerJoin(schema.bottles, eq(schema.bottles.id, schema.pours.bottleId))
      .where(
        and(
          eq(schema.pours.userId, userId),
          gte(schema.pours.createdAt, start),
          lt(schema.pours.createdAt, end),
          inArray(schema.pours.bottleId, [...newBottles]),
        ),
      );
    for (const r of rated) {
      if (r.rating == null) continue;
      if (!bestNewFind || r.rating > bestNewFind.rating) bestNewFind = { bottleId: r.bottleId, name: r.name, rating: r.rating };
    }
  }

  const twins = await getTasteTwins(db, userId, 1).catch(() => []);
  const tasteTwin = twins[0] ? { handle: twins[0].handle, matchPercent: twins[0].matchPercent } : null;

  return {
    year,
    discovered: { countries, regions, distilleries, styles },
    descriptors,
    bestNewFind,
    tasteTwin,
    empty: newBottles.size === 0 && descriptors.length === 0,
  };
}
