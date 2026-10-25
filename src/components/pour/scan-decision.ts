/**
 * What the pour sheet does with a barcode lookup (docs/STORYBOARD.md §2.2,
 * design board decisions S2/S3).
 *
 * - **exact**: the barcode is mapped in our own catalog. The first match fills
 *   the bottle slot straight away — no confirm step — and the sheet shows a
 *   "Not it?" affordance plus an Undo toast. When the barcode is shared by
 *   several releases (S3) the first, most-confirmed one is preselected and the
 *   rest stay one chip away as `alternatives`, so the path is still 3 taps.
 * - **choose**: only unverified suggestions (someone else's pending claim, a
 *   provider's fuzzy name match). Never auto-picked: the user taps one.
 * - **miss**: nothing known. The sheet offers typing and the shelf scanner,
 *   which is where an unknown barcode can teach the catalog.
 *
 * Pure and framework-free so the 3-tap rule can be unit tested.
 */

import { isValidUpc, normalizeUpc } from "@/lib/upc";

/**
 * A detection worth looking up: digits only, then a valid GTIN. The server's
 * normalizer strips non-digits, so a Code 128 serial like `LOT080244002145`
 * would otherwise resolve to a real UPC and auto-pick an unrelated bottle —
 * the same filter the full scanner and the native wrapper apply.
 */
export function productCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const code = normalizeUpc(trimmed);
  return code && isValidUpc(code) ? code : null;
}

export interface ScanBottle {
  id: string;
  name: string;
  distillery?: string | null;
  category?: string | null;
  region?: string | null;
  abv?: number | null;
  ageYears?: number | null;
  /** Only on the viewer's own not-yet-verified claim. */
  pending?: boolean;
}

export interface UpcLookup {
  upc: string;
  matches: ScanBottle[];
  candidates: ScanBottle[];
  externalName: string | null;
}

export type ScanDecision =
  | { kind: "exact"; upc: string; bottle: ScanBottle; alternatives: ScanBottle[] }
  | { kind: "choose"; upc: string; options: ScanBottle[]; externalName: string | null }
  | { kind: "miss"; upc: string };

export function decideScan(lookup: UpcLookup): ScanDecision {
  const matches = Array.isArray(lookup.matches) ? lookup.matches : [];
  const candidates = Array.isArray(lookup.candidates) ? lookup.candidates : [];
  if (matches.length > 0) {
    const [bottle, ...rest] = matches;
    // The viewer's own pending claim resolves their own re-scan (they taught
    // it), and the crowd suggestions behind it stay available as alternatives.
    return { kind: "exact", upc: lookup.upc, bottle, alternatives: [...rest, ...candidates].slice(0, 4) };
  }
  if (candidates.length > 0) {
    return { kind: "choose", upc: lookup.upc, options: candidates.slice(0, 3), externalName: lookup.externalName ?? null };
  }
  return { kind: "miss", upc: lookup.upc };
}

/** "Buffalo Trace · Kentucky · 46.5%" — the one-line identity under a bottle name. */
export function bottleMeta(b: Pick<ScanBottle, "distillery" | "region" | "abv" | "ageYears" | "category">): string {
  return [
    b.distillery ?? null,
    b.region ?? null,
    b.ageYears != null ? `${b.ageYears}y` : null,
    b.abv != null ? `${Number(b.abv.toFixed(1))}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
