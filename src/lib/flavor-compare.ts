/**
 * Note-vs-note flavor comparison: two tasters' descriptor sets on the same
 * bottle, split into what they share and what each named alone. This is the
 * S1 "share link" comparison (docs/SOCIAL.md §16.2) — deliberately separate
 * from `getFlavorCalibration()` in `src/lib/bar.ts`, which compares one
 * person's notes against a producer's across an entire shelf.
 */

import { isValidLeaf, wedgeForLeaf } from "@/lib/flavor-wheel";

export interface FlavorCompareGroup {
  wedgeId: string;
  /** Leaf ids in this wedge, ordered by intensity (theirs desc, then mine desc). */
  leafIds: string[];
}

export interface FlavorCompareResult {
  /** Descriptors both tasters named. */
  both: FlavorCompareGroup[];
  /** Descriptors only "mine" named. */
  onlyMine: FlavorCompareGroup[];
  /** Descriptors only "theirs" named. */
  onlyTheirs: FlavorCompareGroup[];
}

type FlavorTags = Record<string, number> | null | undefined;

function groupByWedge(
  leafIds: string[],
  mine: Record<string, number>,
  theirs: Record<string, number>,
): FlavorCompareGroup[] {
  const sorted = [...leafIds].sort((a, b) => {
    const theirsDiff = (theirs[b] ?? 0) - (theirs[a] ?? 0);
    if (theirsDiff !== 0) return theirsDiff;
    const mineDiff = (mine[b] ?? 0) - (mine[a] ?? 0);
    if (mineDiff !== 0) return mineDiff;
    return a.localeCompare(b);
  });

  const wedgeOrder: string[] = [];
  const byWedge = new Map<string, string[]>();
  for (const leafId of sorted) {
    const wedgeId = wedgeForLeaf(leafId);
    if (!wedgeId) continue; // isValidLeaf guarantees this never happens, but keep this defensive.
    if (!byWedge.has(wedgeId)) {
      byWedge.set(wedgeId, []);
      wedgeOrder.push(wedgeId);
    }
    byWedge.get(wedgeId)!.push(leafId);
  }
  return wedgeOrder.map((wedgeId) => ({ wedgeId, leafIds: byWedge.get(wedgeId)! }));
}

/**
 * Compares two tasters' flavor-tag records (leaf id -> intensity) on one
 * bottle. Ids outside the flavor wheel are ignored. Pure and synchronous —
 * callers own unioning multiple pours into `mine`/`theirs` beforehand.
 */
export function compareFlavorNotes(mine: FlavorTags, theirs: FlavorTags): FlavorCompareResult {
  const mineTags = mine ?? {};
  const theirsTags = theirs ?? {};
  const mineIds = new Set(Object.keys(mineTags).filter(isValidLeaf));
  const theirsIds = new Set(Object.keys(theirsTags).filter(isValidLeaf));

  const bothIds = [...mineIds].filter((id) => theirsIds.has(id));
  const onlyMineIds = [...mineIds].filter((id) => !theirsIds.has(id));
  const onlyTheirsIds = [...theirsIds].filter((id) => !mineIds.has(id));

  return {
    both: groupByWedge(bothIds, mineTags, theirsTags),
    onlyMine: groupByWedge(onlyMineIds, mineTags, theirsTags),
    onlyTheirs: groupByWedge(onlyTheirsIds, mineTags, theirsTags),
  };
}
