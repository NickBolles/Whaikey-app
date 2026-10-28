import type { DB } from "@/db";
import { listMyClubs } from "@/lib/clubs";
import { listMyFlights } from "@/lib/flights";
import { formatVisitDay, nextOutingFor } from "@/lib/outings";

/**
 * "Get together" — the clubs, outings and tasting nights you're part of,
 * condensed for the Home module and the top of Social (owner feedback
 * 2026-10-26: "clubs, trails etc. could be emphasized better"). Reads only
 * the list projections that /clubs already shows the viewer, so it carries
 * the same block / suspension / host-visibility predicates.
 */
export interface NextOuting {
  title: string;
  distilleryName: string | null;
  joinCode: string;
  /** "Today", "Tomorrow", or e.g. "Thu, Oct 29". */
  dayLabel: string;
}

export interface Gatherings {
  nextOuting: NextOuting | null;
  clubCount: number;
  /** Tasting nights still being tasted (not yet revealed or closed). */
  openNights: number;
}

export const EMPTY_GATHERINGS: Gatherings = { nextOuting: null, clubCount: 0, openNights: 0 };

type OutingRow = { title: string; distilleryName: string | null; visitOn: string; joinCode: string; state: string };

/** UTC calendar day of `now`, matching how `visitOn` (YYYY-MM-DD) is stored and shown. */
export function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

/** The soonest outing that is still open and not in the past. */
export function pickNextOuting(rows: OutingRow[], now: Date): NextOuting | null {
  const today = isoDay(now);
  const upcoming = rows
    .filter((o) => o.state !== "ended" && o.visitOn >= today)
    .sort((a, b) => (a.visitOn < b.visitOn ? -1 : a.visitOn > b.visitOn ? 1 : 0));
  const next = upcoming[0];
  if (!next) return null;
  const dayLabel = next.visitOn === today ? "Today" : next.visitOn === addDays(today, 1) ? "Tomorrow" : formatVisitDay(next.visitOn);
  return { title: next.title, distilleryName: next.distilleryName, joinCode: next.joinCode, dayLabel };
}

export async function getGatherings(db: DB, userId: string, now: Date): Promise<Gatherings> {
  const [next, clubs, flights] = await Promise.all([nextOutingFor(db, userId, isoDay(now)), listMyClubs(db, userId), listMyFlights(db, userId)]);
  return {
    nextOuting: pickNextOuting(next ? [next] : [], now),
    clubCount: clubs.length,
    openNights: flights.filter((f) => f.state === "open").length,
  };
}
