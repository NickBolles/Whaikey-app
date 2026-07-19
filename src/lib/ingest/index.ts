import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { bottleAliases, bottles, bottleUpcs, pours, userBottles } from "@/db/schema";
import { slugify } from "./normalize";
import type { CatalogCandidate, IngestReport } from "./types";

export type { CatalogCandidate, IngestReport } from "./types";
export { fetchIowaCandidates } from "./iowa";
export { colaRecordsToCandidates, fetchColaRecords } from "./cola";
export { enrichBottleProfiles, enrichModel, type EnrichReport } from "./enrich";

/**
 * Merge source candidates into the catalog (docs/DATA_SOURCES.md §2, §6).
 *
 * Rules, in order of importance:
 *  - The curated/user catalog always wins: a candidate whose name slug
 *    matches an existing bottle id, name, or alias never overwrites anything —
 *    it only contributes barcodes the bottle doesn't have yet.
 *  - New bottles land with status "imported" (no flavor profile, no
 *    description); search and scan pick them up immediately, and
 *    recommendations — which require a flavor profile — skip them until
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
    dryRun: opts.dryRun ?? false,
  };

  // Existing-catalog index: bottle ids are already slugs (seed convention),
  // plus name slugs and alias slugs, all mapping slug → bottle id.
  const slugToBottle = new Map<string, string>();
  for (const b of await db.select({ id: bottles.id, name: bottles.name }).from(bottles)) {
    slugToBottle.set(b.id, b.id);
    const nameSlug = slugify(b.name);
    if (nameSlug && !slugToBottle.has(nameSlug)) slugToBottle.set(nameSlug, b.id);
  }
  for (const a of await db
    .select({ bottleId: bottleAliases.bottleId, alias: bottleAliases.alias })
    .from(bottleAliases)) {
    const aliasSlug = slugify(a.alias);
    if (aliasSlug && !slugToBottle.has(aliasSlug)) slugToBottle.set(aliasSlug, a.bottleId);
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
    if (bottleId) {
      report.matchedExisting += 1;
    } else {
      bottleId = slug;
      report.inserted += 1;
      slugToBottle.set(slug, bottleId);
      if (!opts.dryRun) {
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
      if (!opts.dryRun) {
        await db
          .insert(bottleUpcs)
          .values({
            id: `${bottleId}--upc-${upc}`,
            bottleId,
            upc,
            source: candidate.source === "iowa" ? "iowa" : "seed",
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
