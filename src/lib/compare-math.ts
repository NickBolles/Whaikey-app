/**
 * Client-safe math and view types for the three-source comparison
 * (/bottles/[id]/compare). No DB imports here — the client component computes
 * matches and agreement rows inline when a tapped chip changes the note; the
 * server assembly lives in src/lib/bottle-compare.ts.
 */

import { isValidLeaf } from "@/lib/flavor-wheel";

export type CompareSource = "friends" | "community" | "professional";

export interface AgreementRow {
  leafId: string;
  /** The viewer's intensity (0 when only the reference logged it — that absence is the point). */
  mine: number;
  /** The reference's intensity (possibly fractional: community means are averages). */
  theirs: number;
}

export function validTags(tags: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [leafId, intensity] of Object.entries(tags ?? {})) {
    if (isValidLeaf(leafId) && typeof intensity === "number" && intensity > 0) {
      out[leafId] = intensity;
    }
  }
  return out;
}

/**
 * Matched intensity over total intensity across the union of both flavor
 * sets (weighted Jaccard), as a whole percent. Null when there is nothing on
 * either side to compare.
 */
export function matchPercent(
  mine: Record<string, number> | null | undefined,
  theirs: Record<string, number> | null | undefined,
): number | null {
  const a = validTags(mine);
  const b = validTags(theirs);
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  let matched = 0;
  let total = 0;
  for (const id of ids) {
    matched += Math.min(a[id] ?? 0, b[id] ?? 0);
    total += Math.max(a[id] ?? 0, b[id] ?? 0);
  }
  if (total === 0) return null;
  return Math.round((matched / total) * 100);
}

/**
 * One row per flavor across the union of both sets, combined intensity
 * descending, capped. Flavors only the reference logged stay in — a zero-width
 * "you" bar is the screen's whole message.
 */
export function agreementRows(
  mine: Record<string, number> | null | undefined,
  theirs: Record<string, number> | null | undefined,
  limit = 6,
): AgreementRow[] {
  const a = validTags(mine);
  const b = validTags(theirs);
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids]
    .map((leafId) => ({ leafId, mine: a[leafId] ?? 0, theirs: b[leafId] ?? 0 }))
    .sort(
      (x, y) =>
        y.mine + y.theirs - (x.mine + x.theirs) ||
        y.theirs - x.theirs ||
        x.leafId.localeCompare(y.leafId),
    )
    .slice(0, limit);
}

/** Mean intensity per leaf across contributors who named it, 1 decimal. */
export function meanTags(records: Array<Record<string, number> | null | undefined>): Record<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const record of records) {
    for (const [leafId, intensity] of Object.entries(validTags(record))) {
      const cur = sums.get(leafId) ?? { total: 0, count: 0 };
      cur.total += intensity;
      cur.count += 1;
      sums.set(leafId, cur);
    }
  }
  const out: Record<string, number> = {};
  for (const [leafId, { total, count }] of sums) {
    out[leafId] = Math.round((total / count) * 10) / 10;
  }
  return out;
}

export interface CompareProseAuthor {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CompareProseNote {
  pourId: string;
  author: CompareProseAuthor;
  rating: number | null;
  createdAt: string;
  text: string | null;
  flavorTags: Record<string, number> | null;
}

export interface CriticNoteView {
  publication: string;
  score: string | null;
  scoreScale: string | null;
  note: string;
  sourceUrl: string;
  flavorTags: Record<string, number> | null;
}

export interface BottleComparison {
  bottleId: string;
  bottleName: string;
  viewerTags: Record<string, number>;
  /** The viewer's latest pour of this bottle — where a tapped "+" chip lands. */
  viewerPourId: string | null;
  friends: { count: number; tags: Record<string, number>; notes: CompareProseNote[] };
  community: { count: number; tags: Record<string, number>; notes: CompareProseNote[] };
  professional: {
    tags: Record<string, number>;
    producer: {
      sourceLabel: string;
      sourceUrl: string;
      text: string | null;
      tags: Record<string, number>;
    } | null;
    critics: CriticNoteView[];
  };
}

