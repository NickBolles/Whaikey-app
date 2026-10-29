import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { bottles, brandLogos, distilleries } from "@/db/schema";
import {
  brandKey,
  buildBrandIndex,
  coreName,
  isMatchableCore,
  matchBottleBrandVia,
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
  /** Bottler/range names matched anywhere in a bottle name ("Old Particular"). */
  markers?: string[];
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
  /**
   * When a (forced) re-check finds no acceptable mark, clear the stored one
   * instead of keeping it. Use after tightening the matching rules so marks
   * the new rules refuse come down. Without it a miss keeps the old mark,
   * because a miss may only mean the source was unreachable.
   */
  clearMissing?: boolean;
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
  logos: Array<{
    key: string;
    name: string;
    source: string | null;
    license: string | null;
    attribution: string | null;
    attributionUrl: string | null;
    card: boolean;
  }>;
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
  /** Brand filing (bottles.brand_key) before → after this run, plus a sample of new filings to audit. */
  filing?: BrandFilingReport;
}

export interface BrandFilingReport {
  bottles: number;
  withBrandBefore: number;
  withBrandAfter: number;
  newlyFiled: number;
  refiled: number;
  unfiled: number;
  byVia: Record<string, number>;
  /** Up to 50 newly-filed bottles, a stable pseudo-random sample by id. */
  sample: Array<{ id: string; name: string; key: string; via: string }>;
  /** Brands that gain bottles this run, busiest first (key → new bottles). */
  gains: Record<string, number>;
}

/** Stable 32-bit hash for a deterministic sample. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
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
    prev.markers = [...new Set([...(prev.markers ?? []), ...(plan.markers ?? [])])];
    prev.anywhere ||= plan.anywhere;
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
      markers: s.markers ?? [],
      anywhere: true,
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
      anywhere: true,
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
    // A curated/distillery plan already owns this key: its identity was
    // resolved (or deliberately left null) above via pickWikidataEntity, so
    // a same-named producer that failed that check must not enrich it with
    // another entity's website/logo files.
    if (plans.has(key)) continue;
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
  const searched = await commonsSearchLogo(ctx, plan.name, plan.country).catch(() => null);
  if (searched) return searched;
  if (plan.website) {
    const site = await websiteLogo(ctx, plan.website, (html) => pageMentionsBrand(html, plan.name), plan.name, plan.aliases).catch(() => null);
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
  const filing: BrandFilingReport = { bottles: 0, withBrandBefore: 0, withBrandAfter: 0, newlyFiled: 0, refiled: 0, unfiled: 0, byVia: {}, sample: [], gains: {} };
  const sampled: Array<{ h: number; id: string; name: string; key: string; via: string }> = [];
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
      const m = matchBottleBrandVia(b, index);
      const key = m?.key ?? null;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      filing.bottles++;
      if (b.brandKey) filing.withBrandBefore++;
      if (m) {
        filing.withBrandAfter++;
        filing.byVia[m.via] = (filing.byVia[m.via] ?? 0) + 1;
      }
      if (m && !b.brandKey) {
        filing.newlyFiled++;
        filing.gains[m.key] = (filing.gains[m.key] ?? 0) + 1;
        sampled.push({ h: hash32(b.id), id: b.id, name: b.name, key: m.key, via: m.via });
        if (sampled.length > 400) sampled.sort((x, y) => x.h - y.h).splice(50);
      } else if (!m && b.brandKey) filing.unfiled++;
      else if (m && b.brandKey && m.key !== b.brandKey) filing.refiled++;
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
  filing.sample = sampled.sort((x, y) => x.h - y.h).slice(0, 50).map((r) => ({ id: r.id, name: r.name, key: r.key, via: r.via }));
  filing.gains = Object.fromEntries(Object.entries(filing.gains).sort((a, b) => b[1] - a[1]));
  log(`brand filing: ${filing.withBrandBefore} → ${filing.withBrandAfter} of ${filing.bottles} (new ${filing.newlyFiled}, refiled ${filing.refiled}, unfiled ${filing.unfiled}) via ${JSON.stringify(filing.byVia)}`);

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
    .where(
      and(
        // A takedown (status 'rejected') is final: never re-fetch, even with --force.
        ne(brandLogos.status, "rejected"),
        opts.force ? sql`true` : or(isNull(brandLogos.checkedAt), lt(brandLogos.checkedAt, staleBefore)),
      ),
    );
  const due = new Set(existing.map((r) => r.key));
  const queue = live
    .filter((p) => (apply ? due.has(p.key) : true))
    .sort((a, b) => (counts.get(b.key) ?? 0) - (counts.get(a.key) ?? 0) || a.key.localeCompare(b.key))
    .slice(0, opts.limit ?? 150);

  const found: Record<string, number> = {};
  let failures = 0;
  const results: Array<{ plan: BrandPlan; logo: FetchedLogo | null; failed: boolean; refused?: boolean }> = [];
  for (const p of queue) {
    let logo: FetchedLogo | null = null;
    // findLogo swallows network errors (each source falls through to the
    // next), so count them here: a lookup that hit a timeout, a connection
    // error or a 5xx is "unreachable", never "no mark" (--clear-missing).
    let transport = 0;
    const counted: typeof fetch = async (input, init) => {
      try {
        const res = await ctx.fetchImpl(input, init);
        if (res.status >= 500 || res.status === 429) transport++;
        return res;
      } catch (err) {
        transport++;
        throw err;
      }
    };
    let failed = false;
    try {
      logo = await findLogo({ ...ctx, fetchImpl: counted }, p);
      failed = transport > 0 && !logo;
    } catch (err) {
      failures++;
      failed = true;
      log(`  ${p.key}: lookup failed (${(err as Error).message})`);
    }
    results.push({ plan: p, logo, failed });
  }

  // A website icon shared by two or more brands is a group/portfolio site's
  // icon (Diageo's "Malts" mark on Talisker and Clynelish), never a brand's
  // own mark: refuse it for every brand that carries it (#136). Stored icons
  // of brands outside this run count too.
  const iconBrands = new Map<string, Set<string>>();
  const addIcon = (hash: string, key: string) => iconBrands.set(hash, (iconBrands.get(hash) ?? new Set()).add(key));
  for (const r of results) if (r.logo?.source === "website") addIcon(logoHash(r.logo.data), r.plan.key);
  const queued = new Set(queue.map((p) => p.key));
  const stored = await db
    .select({ key: brandLogos.key, logoData: brandLogos.logoData })
    .from(brandLogos)
    .where(and(eq(brandLogos.status, "ok"), eq(brandLogos.logoSource, "website")));
  for (const r of stored) if (!queued.has(r.key) && r.logoData) addIcon(logoHash(Buffer.from(r.logoData, "base64")), r.key);
  const sharedKeys = new Set<string>();
  for (const keys of iconBrands.values()) if (keys.size >= 2) for (const k of keys) sharedKeys.add(k);
  for (const r of results) {
    if (r.logo?.source === "website" && sharedKeys.has(r.plan.key)) {
      log(`  ${r.plan.key}: website icon shared with other brands — refused`);
      r.logo = null;
      r.refused = true;
    }
  }
  const sharedStored = [...sharedKeys].filter((k) => !queued.has(k));
  if (apply && sharedStored.length > 0) {
    log(`  clearing shared website icons: ${sharedStored.join(", ")}`);
    await db.update(brandLogos).set(clearedLogo(now)).where(and(inArray(brandLogos.key, sharedStored), eq(brandLogos.status, "ok")));
  }

  for (const { plan: p, logo, failed, refused } of results) {
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
          : // A refused shared icon always comes down; otherwise only with --clear-missing and a clean lookup.
            refused || (opts.clearMissing && !failed)
            ? clearedLogo(now)
            : // Keep a previously found mark when a re-check merely failed to reach the source.
              { checkedAt: now, updatedAt: now },
      )
      .where(eq(brandLogos.key, p.key));
  }

  const coverage = apply ? await logoCoverage(db) : null;
  return { apply, producers: producers.length, brands: live.length, bottlesReassigned: reassigned, checked: queue.length, found, failures, coverage, filing };
}

function logoHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Column values for "no mark" (keeps the identity columns). */
function clearedLogo(now: Date) {
  return {
    status: "none" as const,
    logoUrl: null,
    logoSource: null,
    license: null,
    attribution: null,
    attributionUrl: null,
    attributionRequired: false,
    contentType: null,
    logoData: null,
    width: null,
    height: null,
    checkedAt: now,
    updatedAt: now,
  };
}

/**
 * Take marks down for good (#136): status `rejected`, bytes and credit
 * cleared. Rejected rows are never re-fetched, even with `--force`, and
 * `/api/brand-logo/<key>` and the bottle page only show `ok` rows. Unknown
 * keys get a placeholder row so a later backfill can't fill them either.
 */
export async function rejectBrandLogos(db: DB, keys: string[], opts: { apply?: boolean; now?: Date } = {}): Promise<{ rejected: string[]; created: string[] }> {
  const now = opts.now ?? new Date();
  const clean = [...new Set(keys.map((k) => k.trim().toLowerCase()).filter(Boolean))];
  const bad = clean.filter((k) => !/^[a-z0-9-]{1,80}$/.test(k));
  if (bad.length > 0) throw new Error(`invalid brand key(s): ${bad.join(", ")}`);
  if (clean.length === 0) return { rejected: [], created: [] };
  const existing = new Set((await db.select({ key: brandLogos.key }).from(brandLogos).where(inArray(brandLogos.key, clean))).map((r) => r.key));
  const created = clean.filter((k) => !existing.has(k));
  if (opts.apply) {
    await db.update(brandLogos).set({ ...clearedLogo(now), status: "rejected" }).where(inArray(brandLogos.key, clean));
    for (const k of created) {
      await db.insert(brandLogos).values({ key: k, name: k, status: "rejected", checkedAt: now, updatedAt: now }).onConflictDoNothing();
    }
  }
  return { rejected: clean, created };
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
      name: brandLogos.name,
      attribution: brandLogos.attribution,
      attributionUrl: brandLogos.attributionUrl,
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
    // For the contact sheet (no bytes; render them from /api/brand-logo/<key>).
    logos: rows
      .filter((r) => r.status === "ok")
      .map((r) => ({
        key: r.key,
        name: r.name,
        source: r.logoSource,
        license: r.license,
        attribution: r.attribution,
        attributionUrl: r.attributionUrl,
        card: card.has(r.key),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
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
  const f = r.filing;
  if (f) {
    lines.push(
      "",
      `Brand filing: ${f.withBrandBefore} → ${f.withBrandAfter} of ${f.bottles} bottles (${pct(f.withBrandBefore, f.bottles)} → ${pct(f.withBrandAfter, f.bottles)}) · new ${f.newlyFiled}, refiled ${f.refiled}, unfiled ${f.unfiled} · via ${Object.entries(f.byVia).map(([k, v]) => `${k} ${v}`).join(", ")}`,
      `Top gains: ${Object.entries(f.gains).slice(0, 25).map(([k, v]) => `${k} +${v}`).join(", ") || "—"}`,
    );
  }
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

