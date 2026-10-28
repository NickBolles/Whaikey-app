import { asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, brandLogos, distilleries } from "@/db/schema";
import {
  brandKey,
  buildBrandIndex,
  coreName,
  isMatchableCore,
  matchBottleBrand,
  normalizeName,
  pickWikidataEntity,
  type BrandRef,
} from "./match";
import {
  commonsLogo,
  commonsSearchLogo,
  fetchWikidataProducers,
  HostRateLimiter,
  websiteLogo,
  type FetchContext,
  type FetchedLogo,
  type WikidataProducer,
} from "./fetch";
import { logoAllowedOn } from "./license";

/**
 * The logo backfill (docs/DATA_SOURCES.md §5.4). Idempotent and resumable:
 *
 * 1. Build the brand list — our distilleries, the curated seeds
 *    (config/brand-seeds.json) and every Wikidata whisky producer that at
 *    least one catalog bottle's name starts with.
 * 2. File every bottle under a brand (`bottles.brand_key`), writing only rows
 *    whose key changed.
 * 3. Upsert a `brand_logos` row per brand that has bottles, then look up a
 *    mark for the ones never checked or checked more than `maxAgeDays` ago,
 *    busiest brands first, at most `limit` per run: Wikidata P154/P8972 →
 *    a Commons "<brand> logo" file → the official site's icon → none.
 */
export interface BrandSeed {
  name: string;
  aliases?: string[];
  country?: string;
  website?: string;
  wikidata?: string;
}

export interface LogoBackfillOptions {
  fetchImpl?: typeof fetch;
  limiter?: HostRateLimiter;
  seeds?: BrandSeed[];
  /** Pre-fetched producers (tests); fetched from Wikidata otherwise. */
  producers?: WikidataProducer[];
  limit?: number;
  maxAgeDays?: number;
  force?: boolean;
  apply?: boolean;
  now?: Date;
  log?: (msg: string) => void;
}

export interface LogoCoverage {
  brands: number;
  brandsWithLogo: number;
  bySource: Record<string, number>;
  distilleries: number;
  distilleriesWithLogo: number;
  bottles: number;
  bottlesWithBrand: number;
  bottlesWithCardLogo: number;
  bottlesWithAnyLogo: number;
}

export interface LogoBackfillReport {
  apply: boolean;
  producers: number;
  brands: number;
  bottlesReassigned: number;
  checked: number;
  found: Record<string, number>;
  failures: number;
  coverage: LogoCoverage | null;
}

interface BrandPlan extends BrandRef {
  country: string | null;
  wikidataId: string | null;
  website: string | null;
  logoFiles: string[];
}

function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

/** Merge distilleries, seeds and Wikidata producers into one plan per key. */
export function planBrands(
  dists: Array<{ id: string; name: string; country: string }>,
  seeds: BrandSeed[],
  producers: WikidataProducer[],
): BrandPlan[] {
  const plans = new Map<string, BrandPlan>();
  const byCore = new Map<string, WikidataProducer[]>();
  for (const p of producers) {
    for (const n of [p.label, ...p.aliases]) {
      const c = coreName(n);
      if (!isMatchableCore(c)) continue;
      const list = byCore.get(c) ?? [];
      if (!list.includes(p)) list.push(p);
      byCore.set(c, list);
    }
  }
  const resolve = (name: string, aliases: string[], country: string | null, qid?: string) => {
    if (qid) return producers.find((p) => p.id === qid) ?? null;
    const cands = new Set<WikidataProducer>();
    for (const n of [name, ...aliases]) for (const p of byCore.get(coreName(n)) ?? []) cands.add(p);
    return pickWikidataEntity({ name, aliases, country }, [...cands]);
  };
  const upsert = (plan: BrandPlan) => {
    const prev = plans.get(plan.key);
    if (!prev) return void plans.set(plan.key, plan);
    prev.aliases = [...new Set([...(prev.aliases ?? []), ...(plan.aliases ?? [])])];
    prev.distilleryId ??= plan.distilleryId;
    prev.country ??= plan.country;
    prev.wikidataId ??= plan.wikidataId;
    prev.website ??= plan.website;
    if (prev.logoFiles.length === 0) prev.logoFiles = plan.logoFiles;
  };
  // Curated seeds first: they own their names (buildBrandIndex is first-writer-wins).
  for (const s of seeds) {
    const wd = resolve(s.name, s.aliases ?? [], s.country ?? null, s.wikidata);
    upsert({
      key: brandKey(s.name),
      name: s.name,
      aliases: s.aliases ?? [],
      distilleryId: null,
      country: s.country ?? null,
      wikidataId: wd?.id ?? null,
      website: s.website ?? wd?.website ?? null,
      logoFiles: wd?.logoFiles ?? [],
    });
  }
  for (const d of dists) {
    // "Suntory (Yamazaki & Hakushu)" → name "Suntory", aliases from the parenthesis.
    const paren = /\(([^)]*)\)/.exec(d.name)?.[1];
    const base = d.name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const aliases = paren ? paren.split(/\s*(?:&|,|\/| and )\s*/).filter(Boolean) : [];
    const wd = resolve(base, aliases, d.country);
    const key = brandKey(base);
    const seeded = plans.get(key);
    upsert({
      key,
      name: seeded?.name ?? base,
      aliases,
      distilleryId: d.id,
      country: d.country,
      wikidataId: wd?.id ?? null,
      website: wd?.website ?? null,
      logoFiles: wd?.logoFiles ?? [],
    });
  }
  for (const p of producers) {
    const key = brandKey(p.label);
    if (!isMatchableCore(coreName(p.label))) continue;
    upsert({
      key,
      name: p.label.replace(/\s+(distillery|distilleries)$/i, ""),
      aliases: p.aliases,
      distilleryId: null,
      country: p.countries[0] ?? null,
      wikidataId: p.id,
      website: p.website,
      logoFiles: p.logoFiles,
    });
  }
  return [...plans.values()];
}

/** Does this homepage plausibly belong to the brand? (guards parked/wrong domains) */
export function pageMentionsBrand(html: string, brandName: string): boolean {
  const core = coreName(brandName);
  if (!core) return false;
  const text = ` ${normalizeName(html.replace(/<[^>]+>/g, " "))} `;
  const squashed = text.replace(/ /g, "");
  return text.includes(` ${core} `) || squashed.includes(core.replace(/ /g, ""));
}

export async function findLogo(ctx: FetchContext, plan: BrandPlan): Promise<FetchedLogo | null> {
  for (const file of plan.logoFiles) {
    const logo = await commonsLogo(ctx, file, "wikidata").catch(() => null);
    if (logo) return logo;
  }
  const searched = await commonsSearchLogo(ctx, plan.name).catch(() => null);
  if (searched) return searched;
  if (plan.website) {
    const site = await websiteLogo(ctx, plan.website, (html) => pageMentionsBrand(html, plan.name)).catch(() => null);
    if (site) return site;
  }
  return null;
}

export async function runLogoBackfill(db: DB, opts: LogoBackfillOptions = {}): Promise<LogoBackfillReport> {
  const log = opts.log ?? (() => {});
  const apply = opts.apply ?? false;
  const now = opts.now ?? new Date();
  const ctx: FetchContext = { fetchImpl: opts.fetchImpl ?? fetch, limiter: opts.limiter ?? new HostRateLimiter() };
  const producers = opts.producers ?? (await fetchWikidataProducers(ctx));
  log(`wikidata producers: ${producers.length}`);
  const dists = await db.select({ id: distilleries.id, name: distilleries.name, country: distilleries.country }).from(distilleries);
  const plans = planBrands(dists, opts.seeds ?? [], producers);
  const index = buildBrandIndex(plans);

  // 2. File bottles under brands, in id order, a page at a time.
  const counts = new Map<string, number>();
  let reassigned = 0;
  let cursor = "";
  for (;;) {
    const page = await db
      .select({ id: bottles.id, name: bottles.name, distilleryId: bottles.distilleryId, brandKey: bottles.brandKey })
      .from(bottles)
      .where(gt(bottles.id, cursor))
      .orderBy(asc(bottles.id))
      .limit(2000);
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    const changes: Array<{ id: string; key: string | null }> = [];
    for (const b of page) {
      const key = matchBottleBrand(b, index);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      if (key !== b.brandKey) changes.push({ id: b.id, key });
    }
    reassigned += changes.length;
    if (apply && changes.length > 0) {
      for (let i = 0; i < changes.length; i += 500) {
        const chunk = changes.slice(i, i + 500);
        const values = sql.join(chunk.map((c) => sql`(${c.id}, ${c.key})`), sql`, `);
        await db.execute(sql`update bottles set brand_key = v.k from (values ${values}) as v(id, k) where bottles.id = v.id`);
      }
    }
  }
  log(`bottles reassigned: ${reassigned}`);

  // 3. Brand rows for brands that file at least one bottle (or are a distillery).
  const live = plans.filter((p) => (counts.get(p.key) ?? 0) > 0 || p.distilleryId);
  if (apply) {
    for (const p of live) {
      await db
        .insert(brandLogos)
        .values({ key: p.key, name: p.name, country: p.country, distilleryId: p.distilleryId ?? null, wikidataId: p.wikidataId, website: p.website })
        .onConflictDoUpdate({
          target: brandLogos.key,
          set: { name: p.name, country: p.country, distilleryId: p.distilleryId ?? null, wikidataId: p.wikidataId, website: p.website, updatedAt: now },
        });
    }
  }

  const staleBefore = new Date(now.getTime() - (opts.maxAgeDays ?? 30) * 86_400_000);
  const existing = await db
    .select({ key: brandLogos.key, checkedAt: brandLogos.checkedAt })
    .from(brandLogos)
    .where(opts.force ? sql`true` : or(isNull(brandLogos.checkedAt), lt(brandLogos.checkedAt, staleBefore)));
  const due = new Set(existing.map((r) => r.key));
  const queue = live
    .filter((p) => (apply ? due.has(p.key) : true))
    .sort((a, b) => (counts.get(b.key) ?? 0) - (counts.get(a.key) ?? 0) || a.key.localeCompare(b.key))
    .slice(0, opts.limit ?? 150);

  const found: Record<string, number> = {};
  let failures = 0;
  for (const p of queue) {
    let logo: FetchedLogo | null = null;
    try {
      logo = await findLogo(ctx, p);
    } catch (err) {
      failures++;
      log(`  ${p.key}: lookup failed (${(err as Error).message})`);
    }
    found[logo?.source ?? "none"] = (found[logo?.source ?? "none"] ?? 0) + 1;
    log(`  ${p.key} (${counts.get(p.key) ?? 0} bottles): ${logo ? `${logo.source} ${logo.license.license} ${logo.width}x${logo.height}` : "none"}`);
    if (!apply) continue;
    await db
      .update(brandLogos)
      .set(
        logo
          ? {
              status: "ok",
              logoUrl: logo.pageUrl,
              logoSource: logo.source,
              license: logo.license.license,
              attribution: logo.attribution,
              attributionUrl: logo.attributionUrl,
              attributionRequired: logo.license.attributionRequired,
              contentType: logo.contentType,
              logoData: toBase64(logo.data),
              width: logo.width,
              height: logo.height,
              checkedAt: now,
              updatedAt: now,
            }
          : // Keep a previously found mark when a re-check merely failed to reach the source.
            { checkedAt: now, updatedAt: now },
      )
      .where(eq(brandLogos.key, p.key));
  }

  const coverage = apply ? await logoCoverage(db) : null;
  return { apply, producers: producers.length, brands: live.length, bottlesReassigned: reassigned, checked: queue.length, found, failures, coverage };
}

export async function logoCoverage(db: DB): Promise<LogoCoverage> {
  const rows = await db
    .select({
      key: brandLogos.key,
      status: brandLogos.status,
      logoSource: brandLogos.logoSource,
      license: brandLogos.license,
      attributionRequired: brandLogos.attributionRequired,
      distilleryId: brandLogos.distilleryId,
    })
    .from(brandLogos);
  const bySource: Record<string, number> = {};
  const card = new Set<string>();
  const any = new Set<string>();
  for (const r of rows) {
    if (r.status !== "ok") continue;
    bySource[r.logoSource ?? "?"] = (bySource[r.logoSource ?? "?"] ?? 0) + 1;
    any.add(r.key);
    if (logoAllowedOn(r, "card")) card.add(r.key);
  }
  const [{ n: distTotal }] = await db.select({ n: sql<number>`count(*)::int` }).from(distilleries);
  const distWithLogo = rows.filter((r) => r.distilleryId && any.has(r.key)).length;
  const perBrand = await db
    .select({ key: bottles.brandKey, n: sql<number>`count(*)::int` })
    .from(bottles)
    .groupBy(bottles.brandKey);
  let total = 0;
  let withBrand = 0;
  let withCard = 0;
  let withAny = 0;
  for (const r of perBrand) {
    const n = Number(r.n);
    total += n;
    if (!r.key) continue;
    withBrand += n;
    if (card.has(r.key)) withCard += n;
    if (any.has(r.key)) withAny += n;
  }
  return {
    brands: rows.length,
    brandsWithLogo: any.size,
    bySource,
    distilleries: Number(distTotal),
    distilleriesWithLogo: distWithLogo,
    bottles: total,
    bottlesWithBrand: withBrand,
    bottlesWithCardLogo: withCard,
    bottlesWithAnyLogo: withAny,
  };
}

/** Markdown for the workflow's step summary. */
export function coverageMarkdown(r: LogoBackfillReport): string {
  const c = r.coverage;
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
  const lines = [
    `### Brand logos ${r.apply ? "" : "(dry run)"}`,
    "",
    `Wikidata producers: ${r.producers} · brands with bottles: ${r.brands} · bottles re-filed: ${r.bottlesReassigned} · checked this run: ${r.checked} (failures ${r.failures})`,
    "",
    `Found this run: ${Object.entries(r.found).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`,
  ];
  if (c) {
    lines.push(
      "",
      "| | with a logo | of | % |",
      "|---|---|---|---|",
      `| distilleries | ${c.distilleriesWithLogo} | ${c.distilleries} | ${pct(c.distilleriesWithLogo, c.distilleries)} |`,
      `| brands | ${c.brandsWithLogo} | ${c.brands} | ${pct(c.brandsWithLogo, c.brands)} |`,
      `| bottles (any surface) | ${c.bottlesWithAnyLogo} | ${c.bottles} | ${pct(c.bottlesWithAnyLogo, c.bottles)} |`,
      `| bottles (cards) | ${c.bottlesWithCardLogo} | ${c.bottles} | ${pct(c.bottlesWithCardLogo, c.bottles)} |`,
      "",
      `By source: ${Object.entries(c.bySource).map(([k, v]) => `${k} ${v}`).join(", ") || "—"} · bottles filed under a brand: ${c.bottlesWithBrand} (${pct(c.bottlesWithBrand, c.bottles)})`,
    );
  }
  return lines.join("\n");
}

