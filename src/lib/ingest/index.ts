import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottleAliases, bottles, bottleUpcs, pours, userBottles, UPC_SOURCES, type UpcSource } from "@/db/schema";
import { matchKey, slugify } from "./normalize";
import type { CatalogCandidate, IngestReport } from "./types";

export type { CatalogCandidate, IngestReport } from "./types";
export { fetchIowaCandidates } from "./iowa";
export { COLA_FULL_HISTORY_START, colaRecordsToCandidates, fetchColaRecords } from "./cola";
export { fetchOregonCandidates } from "./oregon";
export { fetchUtahCandidates } from "./utah";
export { fetchBcCandidates } from "./bc";
export { fetchSystembolagetCandidates } from "./systembolaget";
export { fetchWhiskyEditionCandidates } from "./whiskyedition";
export { fetchVinmonopoletCandidates } from "./vinmonopolet";
export { enrichBottleProfiles, enrichModel, type EnrichReport } from "./enrich";

/** UPC provenance for a candidate's barcodes: the source's own tag when it is a UpcSource, else "seed". */
function upcSourceFor(candidate: CatalogCandidate): UpcSource {
  return (UPC_SOURCES as readonly string[]).includes(candidate.source)
    ? (candidate.source as UpcSource)
    : "seed";
}

/** The attribute slice fill-if-null merging operates on. */
interface BottleAttrs {
  abv: number | null;
  ageYears: number | null;
  avgPrice: number | null;
  region: string | null;
}

/**
 * Merge source candidates into the catalog (docs/DATA_SOURCES.md §2, §6).
 *
 * Rules, in order of importance:
 *  - The curated/user catalog always wins: a candidate whose name slug
 *    matches an existing bottle id, name, or alias never overwrites anything.
 *  - Variant dedupe: a candidate whose slug is unknown is also matched by a
 *    normalized cross-source match key (see matchKey in normalize.ts) that
 *    collapses age-statement spellings and style fillers — "The Glenlivet
 *    12 YO Single Malt" links to "Glenlivet 12 Year" instead of duplicating
 *    it. A key shared by two existing bottles is ambiguous and never used.
 *  - Alias recording: any match whose exact slug wasn't already known writes
 *    the candidate's name into bottle_aliases (deterministic id, idempotent),
 *    so the next sync takes the exact-slug fast path and search/scan learn
 *    the variant spelling.
 *  - Fill-if-null: matched bottles gain attributes they lack (abv, ageYears,
 *    avgPrice, region) from the candidate; existing values are never
 *    overwritten. Disagreements on abv (> 0.5), ageYears, or region are
 *    reported as conflicts for a human to review. avgPrice differences are
 *    expected across states and never reported.
 *  - New bottles land with status "imported" (no flavor profile); search and
 *    scan pick them up immediately, and recommendations skip them until
 *    they're enriched.
 *  - Idempotent: re-running the same sync inserts nothing new.
 */
export async function ingestCandidates(
  db: DB,
  source: string,
  candidates: CatalogCandidate[],
  opts: { dryRun?: boolean; scanned?: number } = {},
): Promise<IngestReport> {
  const report: IngestReport = {
    source,
    scanned: opts.scanned ?? candidates.length,
    candidates: candidates.length,
    matchedExisting: 0,
    inserted: 0,
    upcsAdded: 0,
    aliasesAdded: 0,
    fieldsFilled: 0,
    conflicts: [],
    dryRun: opts.dryRun ?? false,
  };

  // Existing-catalog indexes: bottle ids are already slugs (seed convention),
  // plus name slugs and alias slugs (slug → bottle id), plus a match-key map
  // for variant dedupe where a key claimed by two bottles goes ambiguous
  // (null) and is never matched against.
  const slugToBottle = new Map<string, string>();
  const keyToBottle = new Map<string, string | null>();
  const attrsByBottle = new Map<string, BottleAttrs>();
  const registerKey = (key: string, bottleId: string): void => {
    if (!key) return;
    const current = keyToBottle.get(key);
    if (current === undefined) keyToBottle.set(key, bottleId);
    else if (current !== bottleId) keyToBottle.set(key, null);
  };

  const bottleRows = await db
    .select({
      id: bottles.id,
      name: bottles.name,
      abv: bottles.abv,
      ageYears: bottles.ageYears,
      avgPrice: bottles.avgPrice,
      region: bottles.region,
    })
    .from(bottles);
  for (const b of bottleRows) {
    slugToBottle.set(b.id, b.id);
    const nameSlug = slugify(b.name);
    if (nameSlug && !slugToBottle.has(nameSlug)) slugToBottle.set(nameSlug, b.id);
    registerKey(matchKey(b.name), b.id);
    attrsByBottle.set(b.id, { abv: b.abv, ageYears: b.ageYears, avgPrice: b.avgPrice, region: b.region });
  }
  for (const a of await db
    .select({ bottleId: bottleAliases.bottleId, alias: bottleAliases.alias })
    .from(bottleAliases)) {
    const aliasSlug = slugify(a.alias);
    if (aliasSlug && !slugToBottle.has(aliasSlug)) slugToBottle.set(aliasSlug, a.bottleId);
    registerKey(matchKey(a.alias), a.bottleId);
  }
  const knownUpcs = new Set(
    (await db.select({ upc: bottleUpcs.upc, bottleId: bottleUpcs.bottleId }).from(bottleUpcs)).map(
      (r) => `${r.upc}::${r.bottleId}`,
    ),
  );

  for (const candidate of candidates) {
    const slug = slugify(candidate.name);
    if (!slug) continue;

    let bottleId = slugToBottle.get(slug);
    if (!bottleId) {
      const hit = keyToBottle.get(matchKey(candidate.name));
      if (hit) bottleId = hit; // undefined = no key match; null = ambiguous
    }

    if (bottleId) {
      report.matchedExisting += 1;

      // Record the variant spelling so the next sync (and search/scan)
      // resolves it directly.
      if (!slugToBottle.has(slug)) {
        report.aliasesAdded += 1;
        slugToBottle.set(slug, bottleId);
        if (!report.dryRun) {
          await db
            .insert(bottleAliases)
            .values({ id: `${bottleId}--alias-${slug}`, bottleId, alias: candidate.name })
            .onConflictDoNothing();
        }
      }

      const stored = attrsByBottle.get(bottleId);
      if (stored) {
        const fills: Partial<BottleAttrs> = {};
        const conflict = (field: string, candidateValue: unknown, storedValue: unknown): void => {
          report.conflicts.push(
            `${candidate.name} → ${bottleId}: ${field} ${String(candidateValue)} (${source}) vs ${String(storedValue)} (stored)`,
          );
        };

        if (candidate.abv != null) {
          if (stored.abv == null) fills.abv = candidate.abv;
          else if (Math.abs(stored.abv - candidate.abv) > 0.5) conflict("abv", candidate.abv, stored.abv);
        }
        if (candidate.ageYears != null) {
          if (stored.ageYears == null) fills.ageYears = candidate.ageYears;
          else if (stored.ageYears !== candidate.ageYears) conflict("ageYears", candidate.ageYears, stored.ageYears);
        }
        if (candidate.region != null) {
          if (stored.region == null) fills.region = candidate.region;
          else if (stored.region.toLowerCase() !== candidate.region.toLowerCase()) {
            conflict("region", candidate.region, stored.region);
          }
        }
        // Retail prices legitimately differ by state/market: fill-only, never a conflict.
        if (candidate.avgPrice != null && stored.avgPrice == null) fills.avgPrice = candidate.avgPrice;

        const filled = Object.keys(fills).length;
        if (filled > 0) {
          report.fieldsFilled += filled;
          Object.assign(stored, fills);
          if (!report.dryRun) {
            await db.update(bottles).set(fills).where(eq(bottles.id, bottleId));
          }
        }
      }
    } else {
      bottleId = slug;
      report.inserted += 1;
      slugToBottle.set(slug, bottleId);
      registerKey(matchKey(candidate.name), bottleId);
      attrsByBottle.set(bottleId, {
        abv: candidate.abv ?? null,
        ageYears: candidate.ageYears ?? null,
        avgPrice: candidate.avgPrice ?? null,
        region: candidate.region ?? null,
      });
      if (!report.dryRun) {
        await db
          .insert(bottles)
          .values({
            id: bottleId,
            name: candidate.name,
            category: candidate.category,
            region: candidate.region ?? null,
            ageYears: candidate.ageYears ?? null,
            abv: candidate.abv ?? null,
            avgPrice: candidate.avgPrice ?? null,
            status: "imported",
          })
          .onConflictDoNothing();
      }
    }

    for (const upc of candidate.upcs ?? []) {
      const key = `${upc}::${bottleId}`;
      if (knownUpcs.has(key)) continue;
      knownUpcs.add(key);
      report.upcsAdded += 1;
      if (!report.dryRun) {
        await db
          .insert(bottleUpcs)
          .values({
            id: `${bottleId}--upc-${upc}`,
            bottleId,
            upc,
            source: upcSourceFor(candidate),
            confirmedCount: 0,
          })
          .onConflictDoNothing();
      }
    }
  }

  return report;
}

/** Count bottles currently in the catalog (for before/after sync logging). */
export async function countBottles(db: DB): Promise<number> {
  return (await db.select({ id: bottles.id }).from(bottles)).length;
}

/**
 * Remove imported bottles that no user has interacted with (rollback aid for
 * a bad sync). Deleting a bottle CASCADES to user_bottles/pours, so anything
 * referenced by user data is explicitly kept.
 */
export async function pruneImportedBottles(db: DB): Promise<number> {
  const referenced = new Set<string>([
    ...(await db.select({ id: userBottles.bottleId }).from(userBottles)).map((r) => r.id),
    ...(await db.select({ id: pours.bottleId }).from(pours)).map((r) => r.id),
  ]);
  const rows = await db
    .select({ id: bottles.id })
    .from(bottles)
    .where(eq(bottles.status, "imported"));
  let removed = 0;
  for (const row of rows) {
    if (referenced.has(row.id)) continue;
    await db.delete(bottles).where(eq(bottles.id, row.id));
    removed += 1;
  }
  return removed;
}
