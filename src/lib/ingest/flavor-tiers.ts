import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { DB } from "@/db";
import { FLAVOR_PROFILE_TIERS, type FlavorProfileTier } from "@/db/schema";
import { parseModelJson } from "@/lib/ai/json";
import { WEDGE_IDS, isValidLeaf, matchLeafIds, rollUpToWedges, wedgeForLeaf } from "@/lib/flavor-wheel";
import { inPopularTop, LEGACY_REFRESH_SAFE, POPULAR_REFRESH_TOP, popularitySql } from "@/lib/popularity";
import { buildEnrichPrompt, cleanProfile, profileFromNotes, type EnrichableBottle } from "./enrich";

/**
 * Tiered flavor-profile backfill (docs/DATA_SOURCES.md §2.4).
 *
 *   free  — community roll-up (≥2 tagged user notes) and a keyword pass that
 *           maps producer/critic/user descriptors and catalog description
 *           text onto wheel leaves with `matchLeafIds`. No model call.
 *   cheap — a small subscription model, no web search, ~25 bottles/request.
 *   heavy — a stronger model with web search, for the most popular bottles.
 *
 * Every write records provenance (tier, confidence, method/model, pass, date)
 * in `bottle_flavor_provenance` and only lands over an equal-or-lower tier.
 * Profiles with no provenance row predate tracking ("legacy") and are left
 * alone — except by a web-grounded (`model_web`) write flagged
 * `allowLegacy`, which callers set only for bottles in the top popularity set
 * (src/lib/popularity.ts) and which still never lands on a user submission or
 * a bottle with tasting notes. The replaced profile is kept in provenance.
 */

export const TIER_RANK: Record<FlavorProfileTier, number> = {
  keyword: 1,
  model: 2,
  model_web: 3,
  community: 4,
};

export const TIER_CONFIDENCE: Record<FlavorProfileTier, number> = {
  keyword: 0.3,
  model: 0.5,
  model_web: 0.75,
  community: 0.9,
};

export type FlavorPass = "free" | "cheap" | "heavy";

export interface ProfileWrite {
  bottleId: string;
  profile: Record<string, number>;
  tier: FlavorProfileTier;
  confidence: number;
  method: string;
  model: string | null;
  pass: FlavorPass;
  inputHash: string | null;
  /** May replace an untracked legacy profile (model_web only; top-popular refresh). */
  allowLegacy?: boolean;
}

/** Idempotent DDL, identical to the drizzle migration, so a branch run never needs `migrateDb`. */
export async function ensureFlavorProvenanceTable(db: DB): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "bottle_flavor_provenance" (
    "bottle_id" text PRIMARY KEY NOT NULL
      CONSTRAINT "bottle_flavor_provenance_bottle_id_bottles_id_fk" REFERENCES "bottles"("id") ON DELETE cascade,
    "tier" text NOT NULL,
    "confidence" double precision NOT NULL,
    "method" text NOT NULL,
    "model" text,
    "pass" text NOT NULL,
    "input_hash" text,
    "enriched_at" timestamp with time zone DEFAULT now() NOT NULL
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "bottle_flavor_provenance_tier_idx" ON "bottle_flavor_provenance" USING btree ("tier")`);
  await db.execute(sql`ALTER TABLE "bottle_flavor_provenance" ADD COLUMN IF NOT EXISTS "replaced_legacy_profile" jsonb`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "bottle_popularity_daily" (
    "bottle_id" text NOT NULL
      CONSTRAINT "bottle_popularity_daily_bottle_id_bottles_id_fk" REFERENCES "bottles"("id") ON DELETE cascade,
    "day" text NOT NULL,
    "searches" integer DEFAULT 0 NOT NULL,
    "views" integer DEFAULT 0 NOT NULL,
    "scans" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "bottle_popularity_daily_bottle_id_day_pk" PRIMARY KEY("bottle_id","day")
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "bottle_popularity_daily_day_idx" ON "bottle_popularity_daily" USING btree ("day")`);
}

/** Strict 8-wedge validation: exactly the wheel's wedge ids, integers 0-10, not all zero. */
export function isValidWedgeProfile(profile: unknown): profile is Record<string, number> {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return false;
  const keys = Object.keys(profile);
  if (keys.length !== WEDGE_IDS.length || !WEDGE_IDS.every((w) => keys.includes(w))) return false;
  const values = Object.values(profile as Record<string, unknown>);
  if (!values.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10)) return false;
  return values.some((v) => v !== 0);
}

function rankSql(column: SQL): SQL {
  return sql`CASE ${column} WHEN 'keyword' THEN 1 WHEN 'model' THEN 2 WHEN 'model_web' THEN 3 WHEN 'community' THEN 4 ELSE 99 END`;
}

/**
 * Write profiles in one statement per chunk. The guard lives in SQL so it
 * holds against whatever is in the row *now*: a profile lands only when the
 * bottle has none, or its recorded tier ranks ≤ the new tier. Legacy
 * profiles (no provenance row) and higher tiers are left alone. Returns the
 * ids that were actually written.
 */
export async function writeTieredProfiles(db: DB, writes: ProfileWrite[], chunkSize = 400): Promise<string[]> {
  const written: string[] = [];
  for (const w of writes) {
    if (!isValidWedgeProfile(w.profile)) throw new Error(`invalid profile for ${w.bottleId}`);
    if (!FLAVOR_PROFILE_TIERS.includes(w.tier)) throw new Error(`invalid tier ${w.tier}`);
  }
  for (let i = 0; i < writes.length; i += chunkSize) {
    const chunk = writes.slice(i, i + chunkSize);
    const values = sql.join(
      chunk.map(
        (w) =>
          sql`(${w.bottleId}::text, ${JSON.stringify(w.profile)}::jsonb, ${w.tier}::text, ${w.confidence}::double precision, ${w.method}::text, ${w.model}::text, ${w.pass}::text, ${w.inputHash}::text, ${w.allowLegacy === true && w.tier === "model_web"}::boolean)`,
      ),
      sql`, `,
    );
    // `prev` reads the rows as they were before this statement (one snapshot),
    // so a legacy profile that gets replaced is kept in provenance.
    const result = await db.execute(sql`
      WITH v(bottle_id, profile, tier, confidence, method, model, pass, input_hash, allow_legacy) AS (VALUES ${values}),
      prev AS (
        SELECT b.id, b.flavor_profile AS old_profile, p.tier AS old_tier
        FROM bottles b JOIN v ON v.bottle_id = b.id LEFT JOIN bottle_flavor_provenance p ON p.bottle_id = b.id
      ),
      upd AS (
        UPDATE bottles b SET flavor_profile = v.profile
        FROM v LEFT JOIN bottle_flavor_provenance p ON p.bottle_id = v.bottle_id
        WHERE b.id = v.bottle_id
          AND (b.flavor_profile IS NULL
            OR (p.tier IS NOT NULL AND ${rankSql(sql`p.tier`)} <= ${rankSql(sql`v.tier`)})
            OR (p.tier IS NULL AND v.allow_legacy AND v.tier = 'model_web' AND ${LEGACY_REFRESH_SAFE}))
        RETURNING b.id
      )
      INSERT INTO bottle_flavor_provenance (bottle_id, tier, confidence, method, model, pass, input_hash, replaced_legacy_profile, enriched_at)
      SELECT v.bottle_id, v.tier, v.confidence, v.method, v.model, v.pass, v.input_hash,
             CASE WHEN prev.old_profile IS NOT NULL AND prev.old_tier IS NULL THEN prev.old_profile END, now()
      FROM v JOIN upd ON upd.id = v.bottle_id JOIN prev ON prev.id = v.bottle_id
      ON CONFLICT (bottle_id) DO UPDATE SET
        tier = excluded.tier, confidence = excluded.confidence, method = excluded.method,
        model = excluded.model, pass = excluded.pass, input_hash = excluded.input_hash,
        replaced_legacy_profile = COALESCE(bottle_flavor_provenance.replaced_legacy_profile, excluded.replaced_legacy_profile),
        enriched_at = excluded.enriched_at
      RETURNING bottle_id
    `);
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<{ bottle_id: string }>;
    for (const row of rows) written.push(row.bottle_id);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Free pass: keyword matcher
// ---------------------------------------------------------------------------

export interface KeywordInputs {
  description: string | null;
  producerFlavorTags: Record<string, number> | null;
  criticNotes: Array<{ note: string; flavorTags: Record<string, number> | null }>;
  userNotes: Array<{ text: string; flavorTags: Record<string, number> | null }>;
}

/** Minimum evidence before a keyword profile is worth writing. */
export const KEYWORD_MIN_LEAVES = 3;
export const KEYWORD_MIN_WEDGES = 2;

export function keywordInputHash(inputs: KeywordInputs): string {
  return createHash("sha1").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}

/**
 * Leaf heat from every text/tag source we hold, then rolled up to wedges.
 * Structured tags (producer, critic, user) keep their 1-3 intensity; a leaf
 * named in free text scores 1 per source that names it, capped at 3. Returns
 * null below the evidence floor — a one-word match is noise, not a profile.
 */
export function keywordProfile(inputs: KeywordInputs): Record<string, number> | null {
  const leaves: Record<string, number> = {};
  const bump = (leaf: string, by: number) => {
    if (!isValidLeaf(leaf)) return;
    leaves[leaf] = Math.min(3, Math.max(leaves[leaf] ?? 0, 0) + by);
  };
  const tagSources = [inputs.producerFlavorTags, ...inputs.criticNotes.map((c) => c.flavorTags), ...inputs.userNotes.map((u) => u.flavorTags)];
  for (const tags of tagSources) {
    for (const [leaf, n] of Object.entries(tags ?? {})) {
      if (typeof n === "number" && n > 0) bump(leaf, Math.min(3, Math.round(n)));
    }
  }
  const texts = [inputs.description, ...inputs.criticNotes.map((c) => c.note), ...inputs.userNotes.map((u) => u.text)];
  for (const text of texts) {
    if (!text) continue;
    for (const leaf of matchLeafIds(text)) bump(leaf, 1);
  }
  const leafIds = Object.keys(leaves);
  const wedges = new Set(leafIds.map((l) => wedgeForLeaf(l)));
  if (leafIds.length < KEYWORD_MIN_LEAVES || wedges.size < KEYWORD_MIN_WEDGES) return null;
  const rolled = rollUpToWedges(leaves);
  const profile: Record<string, number> = {};
  for (const wedge of WEDGE_IDS) profile[wedge] = Math.min(10, Math.round(rolled[wedge] ?? 0));
  return isValidWedgeProfile(profile) ? profile : null;
}

// ---------------------------------------------------------------------------
// Free pass driver
// ---------------------------------------------------------------------------

export interface FreePassReport {
  bottles: number;
  community: number;
  keyword: number;
  keywordUnchanged: number;
  skippedHigherOrLegacy: number;
  written: number;
  dryRun: boolean;
}

interface CatalogRow {
  id: string;
  description: string | null;
  has_profile: boolean;
  producer_flavor_tags: Record<string, number> | null;
  tier: FlavorProfileTier | null;
  input_hash: string | null;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as T[];
}

export async function runFreePass(db: DB, opts: { dryRun?: boolean; now?: Date } = {}): Promise<FreePassReport> {
  await ensureFlavorProvenanceTable(db);
  const catalog = rowsOf<CatalogRow>(await db.execute(sql`
    SELECT b.id, b.description, (b.flavor_profile IS NOT NULL) AS has_profile, b.producer_flavor_tags,
           p.tier, p.input_hash
    FROM bottles b LEFT JOIN bottle_flavor_provenance p ON p.bottle_id = b.id
    ORDER BY b.id`));
  const notes = rowsOf<{ bottle_id: string; flavor_tags: Record<string, number> | null; nose: string | null; palate: string | null; finish: string | null; freeform: string | null }>(
    await db.execute(sql`
      SELECT po.bottle_id, tn.flavor_tags, tn.nose, tn.palate, tn.finish, tn.freeform
      FROM tasting_notes tn JOIN pours po ON po.id = tn.pour_id
      ORDER BY tn.created_at DESC`),
  );
  const critics = rowsOf<{ bottle_id: string; note: string; flavor_tags: Record<string, number> | null }>(
    await db.execute(sql`SELECT bottle_id, note, flavor_tags FROM critic_notes ORDER BY id`),
  );
  const notesBy = new Map<string, typeof notes>();
  for (const n of notes) notesBy.set(n.bottle_id, [...(notesBy.get(n.bottle_id) ?? []), n]);
  const criticsBy = new Map<string, typeof critics>();
  for (const c of critics) criticsBy.set(c.bottle_id, [...(criticsBy.get(c.bottle_id) ?? []), c]);

  const report: FreePassReport = {
    bottles: catalog.length, community: 0, keyword: 0, keywordUnchanged: 0, skippedHigherOrLegacy: 0, written: 0,
    dryRun: opts.dryRun ?? false,
  };
  const writes: ProfileWrite[] = [];
  for (const row of catalog) {
    // Legacy profiles (seed data / pre-tracking enrichment) are never touched.
    if (row.has_profile && row.tier == null) { report.skippedHigherOrLegacy += 1; continue; }
    const bottleNotes = notesBy.get(row.id) ?? [];
    const community = profileFromNotes(bottleNotes.map((n) => ({ flavorTags: n.flavor_tags, nose: n.nose, palate: n.palate, finish: n.finish })));
    if (community) {
      const hash = createHash("sha1").update(JSON.stringify(community)).digest("hex").slice(0, 16);
      if (row.tier === "community" && row.input_hash === hash) continue;
      report.community += 1;
      writes.push({ bottleId: row.id, profile: community, tier: "community", confidence: TIER_CONFIDENCE.community, method: "community-notes", model: null, pass: "free", inputHash: hash });
      continue;
    }
    if (row.tier != null && TIER_RANK[row.tier] > TIER_RANK.keyword) { report.skippedHigherOrLegacy += 1; continue; }
    const inputs: KeywordInputs = {
      description: row.description,
      producerFlavorTags: row.producer_flavor_tags,
      criticNotes: (criticsBy.get(row.id) ?? []).map((c) => ({ note: c.note, flavorTags: c.flavor_tags })),
      userNotes: bottleNotes.map((n) => ({ text: [n.nose, n.palate, n.finish, n.freeform].filter(Boolean).join(". "), flavorTags: n.flavor_tags })),
    };
    const hash = keywordInputHash(inputs);
    if (row.tier === "keyword" && row.input_hash === hash) { report.keywordUnchanged += 1; continue; }
    const profile = keywordProfile(inputs);
    if (!profile) continue;
    report.keyword += 1;
    const strong = inputs.producerFlavorTags != null || inputs.criticNotes.length > 0;
    writes.push({ bottleId: row.id, profile, tier: "keyword", confidence: strong ? 0.4 : TIER_CONFIDENCE.keyword, method: "keyword-matcher", model: null, pass: "free", inputHash: hash });
  }
  if (!report.dryRun) report.written = (await writeTieredProfiles(db, writes)).length;
  return report;
}

// ---------------------------------------------------------------------------
// Model passes: export candidates as prompt batches, apply validated results
// ---------------------------------------------------------------------------

export interface ExportBatch {
  pass: Exclude<FlavorPass, "free">;
  bottleIds: string[];
  prompt: string;
}

export interface ExportOptions {
  /** Max bottles for the cheap pass (missing profiles, then keyword-tier ones). */
  cheapLimit: number;
  cheapBatchSize?: number;
  /**
   * Top-N most popular bottles (src/lib/popularity.ts: pours, shelves, scans,
   * searches, views, retail breadth) below model_web tier for the heavy pass —
   * including untracked legacy profiles inside the top set.
   */
  heavyTop: number;
  heavyBatchSize?: number;
  /** Include keyword-tier bottles in the cheap pass once missing ones are exhausted. */
  upgradeKeyword?: boolean;
}

export interface ExportResult {
  generatedAt: string;
  counts: { missing: number; keywordTier: number; cheap: number; heavy: number; popularBelowWeb: number; heavyLegacy: number };
  batches: ExportBatch[];
}

interface CandidateRow {
  id: string;
  name: string;
  category: string;
  distillery: string | null;
  region: string | null;
  abv: number | null;
  age_years: number | null;
  description: string | null;
  has_profile: boolean;
  tier: FlavorProfileTier | null;
  popularity: number;
  legacy: boolean;
}

const HEAVY_PROMPT_SUFFIX = [
  "",
  "You have a web search tool. For each bottle, run at most one search (e.g. \"<bottle name> tasting notes review\") when you do not already know the specific bottling well, and ground the profile in published tasting notes.",
  "Your final message must be the STRICT JSON array only.",
].join("\n");

export async function exportModelCandidates(db: DB, opts: ExportOptions): Promise<ExportResult> {
  await ensureFlavorProvenanceTable(db);
  const rows = rowsOf<CandidateRow>(await db.execute(sql`
    WITH pop AS (${popularitySql()}),
    -- The top set: legacy (untracked) profiles inside it may be refreshed.
    top AS (
      SELECT pop.bottle_id FROM pop JOIN bottles b ON b.id = pop.bottle_id
      WHERE b.status <> 'user_submitted'
      ORDER BY pop.popularity DESC, pop.bottle_id LIMIT ${Math.max(0, opts.heavyTop)}
    )
    SELECT b.id, b.name, b.category, d.name AS distillery, b.region, b.abv, b.age_years, b.description,
           (b.flavor_profile IS NOT NULL) AS has_profile, p.tier, COALESCE(pop.popularity, 0)::int AS popularity,
           (b.flavor_profile IS NOT NULL AND p.bottle_id IS NULL) AS legacy
    FROM bottles b
    LEFT JOIN distilleries d ON d.id = b.distillery_id
    LEFT JOIN bottle_flavor_provenance p ON p.bottle_id = b.id
    LEFT JOIN pop ON pop.bottle_id = b.id
    WHERE b.flavor_profile IS NULL OR p.tier IN ('keyword', 'model')
       OR (p.bottle_id IS NULL AND b.id IN (SELECT bottle_id FROM top) AND ${LEGACY_REFRESH_SAFE})
    ORDER BY COALESCE(pop.popularity, 0) DESC, (b.description IS NOT NULL) DESC, b.id`));
  const toEnrichable = (r: CandidateRow): EnrichableBottle => ({
    id: r.id, name: r.name, category: r.category, distillery: r.distillery, region: r.region,
    abv: r.abv, ageYears: r.age_years, description: r.description?.slice(0, 600) ?? null, userNotes: [],
  });
  const missing = rows.filter((r) => !r.has_profile);
  const keywordTier = rows.filter((r) => r.tier === "keyword");
  // Heavy: popular bottles (any interaction) not yet at model_web or better,
  // plus legacy profiles in the top set — most popular first.
  const popularBelowWeb = rows.filter((r) => r.popularity > 0);
  const heavy = popularBelowWeb.slice(0, opts.heavyTop);
  // Cheap covers every missing bottle (popular first) so coverage never waits
  // on heavy-pass budget; heavy then upgrades the popular ones to model_web.
  const cheapPool = [...missing, ...(opts.upgradeKeyword ? keywordTier : [])];
  const cheap = cheapPool.slice(0, opts.cheapLimit);

  const batches: ExportBatch[] = [];
  const chunk = (list: CandidateRow[], size: number, pass: ExportBatch["pass"]) => {
    for (let i = 0; i < list.length; i += size) {
      const slice = list.slice(i, i + size).map(toEnrichable);
      const prompt = buildEnrichPrompt(slice, false) + (pass === "heavy" ? HEAVY_PROMPT_SUFFIX : "");
      batches.push({ pass, bottleIds: slice.map((b) => b.id), prompt });
    }
  };
  chunk(heavy, opts.heavyBatchSize ?? 5, "heavy");
  chunk(cheap, opts.cheapBatchSize ?? 25, "cheap");
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      missing: missing.length,
      keywordTier: keywordTier.length,
      cheap: cheap.length,
      heavy: heavy.length,
      popularBelowWeb: popularBelowWeb.length,
      heavyLegacy: heavy.filter((r) => r.legacy).length,
    },
    batches,
  };
}

export interface ModelResultBatch {
  pass: Exclude<FlavorPass, "free">;
  model: string;
  bottleIds: string[];
  /** Raw model text. Parsed and validated here, never trusted. */
  raw: string;
  completedAt: string;
}

export interface ApplyReport {
  batches: number;
  parsed: number;
  rejected: number;
  written: number;
  byPass: Record<string, { parsed: number; written: number }>;
  /** Untracked legacy profiles replaced (top-popular, web-grounded writes only). */
  legacyReplaced: number;
  dryRun: boolean;
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

/** Turn raw model batches into guarded profile writes. Ids outside the batch, bad shapes and duplicates are dropped. */
export function parseModelResults(results: ModelResultBatch[]): { writes: ProfileWrite[]; rejected: number } {
  // One write per bottle: a bottle can appear in a cheap AND a heavy batch;
  // keep the higher tier (a duplicate id in one statement would also abort it).
  const best = new Map<string, ProfileWrite>();
  let rejected = 0;
  for (const batch of results) {
    if ((batch.pass !== "cheap" && batch.pass !== "heavy") || !MODEL_ID.test(batch.model)) {
      rejected += batch.bottleIds.length;
      continue;
    }
    const allowed = new Set(batch.bottleIds);
    const parsed = parseModelJson(batch.raw);
    const entries = Array.isArray(parsed) ? parsed : parsed != null ? [parsed] : [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, profile } = entry as { id?: unknown; profile?: unknown };
      if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) continue;
      const clean = cleanProfile(profile);
      if (!clean || !isValidWedgeProfile(clean)) continue;
      seen.add(id);
      const tier: FlavorProfileTier = batch.pass === "heavy" ? "model_web" : "model";
      const prev = best.get(id);
      if (prev && TIER_RANK[prev.tier] >= TIER_RANK[tier]) continue;
      best.set(id, {
        bottleId: id, profile: clean, tier, confidence: TIER_CONFIDENCE[tier],
        method: `codex:${batch.model}`, model: batch.model, pass: batch.pass, inputHash: null,
      });
    }
    rejected += batch.bottleIds.length - seen.size;
  }
  return { writes: [...best.values()], rejected };
}

export async function applyModelResults(
  db: DB,
  results: ModelResultBatch[],
  opts: { dryRun?: boolean; legacyTop?: number } = {},
): Promise<ApplyReport> {
  await ensureFlavorProvenanceTable(db);
  const { writes, rejected } = parseModelResults(results);
  // Legacy overwrite is decided HERE, from the live ranking, never from the
  // results file: only web-grounded writes for bottles in the top set.
  const heavyIds = writes.filter((w) => w.tier === "model_web").map((w) => w.bottleId);
  const top = await inPopularTop(db, heavyIds, opts.legacyTop ?? POPULAR_REFRESH_TOP);
  for (const w of writes) if (w.tier === "model_web" && top.has(w.bottleId)) w.allowLegacy = true;
  const report: ApplyReport = {
    batches: results.length, parsed: writes.length, rejected, written: 0, byPass: {}, legacyReplaced: 0, dryRun: opts.dryRun ?? false,
  };
  for (const w of writes) {
    const b = (report.byPass[w.pass] ??= { parsed: 0, written: 0 });
    b.parsed += 1;
  }
  if (report.dryRun) return report;
  const legacyBefore = await legacyIds(db, writes.filter((w) => w.allowLegacy).map((w) => w.bottleId));
  const written = new Set(await writeTieredProfiles(db, writes));
  report.written = written.size;
  report.legacyReplaced = [...legacyBefore].filter((id) => written.has(id)).length;
  for (const w of writes) if (written.has(w.bottleId)) report.byPass[w.pass].written += 1;
  return report;
}

/** Of these ids, the bottles whose profile is untracked (legacy). */
async function legacyIds(db: DB, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = rowsOf<{ id: string }>(await db.execute(sql`
    SELECT b.id FROM bottles b LEFT JOIN bottle_flavor_provenance p ON p.bottle_id = b.id
    WHERE b.flavor_profile IS NOT NULL AND p.bottle_id IS NULL
      AND b.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`));
  return new Set(rows.map((r) => r.id));
}

export interface CoverageReport {
  bottles: number;
  withProfile: number;
  coveragePct: number;
  byTier: Record<string, number>;
  legacy: number;
}

export async function flavorCoverage(db: DB): Promise<CoverageReport> {
  await ensureFlavorProvenanceTable(db);
  const [totals] = rowsOf<{ bottles: number; with_profile: number; legacy: number }>(await db.execute(sql`
    SELECT COUNT(*)::int AS bottles, COUNT(b.flavor_profile)::int AS with_profile,
           COUNT(*) FILTER (WHERE b.flavor_profile IS NOT NULL AND p.bottle_id IS NULL)::int AS legacy
    FROM bottles b LEFT JOIN bottle_flavor_provenance p ON p.bottle_id = b.id`));
  const tiers = rowsOf<{ tier: string; n: number }>(await db.execute(sql`
    SELECT p.tier, COUNT(*)::int AS n FROM bottle_flavor_provenance p JOIN bottles b ON b.id = p.bottle_id
    WHERE b.flavor_profile IS NOT NULL GROUP BY p.tier`));
  const byTier: Record<string, number> = {};
  for (const t of tiers) byTier[t.tier] = Number(t.n);
  const bottles = Number(totals?.bottles ?? 0);
  const withProfile = Number(totals?.with_profile ?? 0);
  return { bottles, withProfile, coveragePct: bottles ? Math.round((withProfile / bottles) * 1000) / 10 : 0, byTier, legacy: Number(totals?.legacy ?? 0) };
}
