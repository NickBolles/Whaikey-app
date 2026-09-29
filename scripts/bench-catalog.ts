#!/usr/bin/env tsx
/**
 * Catalog read benchmark (review WP-21/WP-22): catalog search, the discovery
 * rail and the passport, timed against a synthetic catalog scaled to what the
 * COLA/state-feed imports will produce — so an index or a LIMIT is judged by a
 * number rather than by how it reads.
 *
 *   DATABASE_URL=postgres://… pnpm tsx scripts/bench-catalog.ts [--scale 100000] [--runs 15]
 *
 * Runs against DATABASE_URL (a PGlite directory when it is not a postgres://
 * URL). It migrates, loads the seed catalog, then tops the catalog up with
 * synthetic bottles until it holds `--scale` of them: about 20% verified, 78%
 * imported (the COLA shape: many unvetted label rows) and 2% other people's
 * pending submissions. Idempotent — a second run reuses the rows — and
 * ANALYZEs before timing so the planner sees the real distribution.
 *
 * Never point this at a database whose catalog you care about: it writes
 * thousands of `bench-*` bottles and a `bench-user`.
 */
import { sql } from "drizzle-orm";
import { closeDb, createDb, isPostgresUrl, resolveDbUrl, type DB } from "../src/db/index";
import { migrateDb } from "../src/db/migrate";
import { seedDatabase } from "../src/db/seed/index";
import * as schema from "../src/db/schema";
import { searchBottles } from "../src/lib/search";
import { recommendBottles } from "../src/lib/recommend";
import { getPassport } from "../src/lib/passport";

const args = process.argv.slice(2);
const argValue = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const SCALE = argValue("--scale", 100_000);
const RUNS = argValue("--runs", 15);

const WEDGES = ["fruity", "floral", "grain", "sweet", "woody", "spicy", "peaty", "feinty"] as const;
const COUNTRIES: Array<[string, string[]]> = [
  ["USA", ["Kentucky", "Tennessee", "Texas", "Indiana", "New York", "Colorado", "Washington"]],
  ["Scotland", ["Islay", "Speyside", "Highland", "Lowland", "Campbeltown", "Islands"]],
  ["Ireland", []],
  ["Japan", ["Osaka", "Hokkaido", "Yamanashi"]],
  ["Canada", ["Ontario", "Alberta", "British Columbia"]],
  ["India", ["Goa", "Karnataka"]],
  ["Taiwan", []],
  ["Australia", ["Tasmania", "Victoria"]],
];
const CATEGORIES = schema.WHISKEY_CATEGORIES;
const SYLLABLES = ["ar", "bel", "cor", "dun", "ell", "fin", "glen", "hal", "is", "kil", "lo", "mor",
  "nock", "ob", "pit", "quin", "ros", "stra", "tay", "ul", "van", "wick", "yar", "zan", "ach", "bre",
  "cal", "dal", "tor", "more", "loch", "burn", "ford", "ley", "ton", "vie"];
const EXPRESSIONS = ["Single Barrel", "Small Batch", "Cask Strength", "Bottled-in-Bond", "Port Finish",
  "Sherry Cask", "Double Oak", "Reserve", "Private Selection", "Rye", "Peated", "Heritage", "Batch"];

/** Deterministic PRNG so every run builds the same catalog. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function brandName(r: () => number): string {
  const n = 2 + Math.floor(r() * 2);
  let w = "";
  for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(r() * SYLLABLES.length)];
  return w[0].toUpperCase() + w.slice(1);
}

async function ensureScaledCatalog(db: DB): Promise<void> {
  await seedDatabase(db);
  await db.insert(schema.user)
    .values([
      { id: "bench-user", name: "Bench", email: "bench@example.invalid", emailVerified: true },
      { id: "bench-other", name: "Other", email: "bench-other@example.invalid", emailVerified: true },
    ])
    .onConflictDoNothing();

  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.bottles);
  let have = Number(n);
  if (have >= SCALE) return;

  const r = rng(42);
  const distilleryIds: string[] = [];
  const distRows = Array.from({ length: Math.max(50, Math.floor(SCALE / 60)) }, (_, i) => {
    const [country, regions] = COUNTRIES[Math.floor(r() * COUNTRIES.length)];
    const id = `bench-dist-${i}`;
    distilleryIds.push(id);
    return {
      id,
      name: `${brandName(r)} Distillery`,
      country,
      region: regions.length ? regions[Math.floor(r() * regions.length)] : null,
    };
  });
  for (let i = 0; i < distRows.length; i += 500) {
    await db.insert(schema.distilleries).values(distRows.slice(i, i + 500)).onConflictDoNothing();
  }

  const started = Date.now();
  let i = have;
  while (have < SCALE) {
    const batch: (typeof schema.bottles.$inferInsert)[] = [];
    const aliases: (typeof schema.bottleAliases.$inferInsert)[] = [];
    for (let k = 0; k < 1000 && have + batch.length < SCALE; k++, i++) {
      const [country, regions] = COUNTRIES[Math.floor(r() * COUNTRIES.length)];
      const roll = r();
      const status = roll < 0.2 ? "verified" : roll < 0.98 ? "imported" : "user_submitted";
      const age = r() < 0.5 ? 4 + Math.floor(r() * 21) : null;
      const brand = brandName(r);
      const name = `${brand} ${EXPRESSIONS[Math.floor(r() * EXPRESSIONS.length)]}${age ? ` ${age} Year` : ""}`;
      const profile = r() < 0.7
        ? Object.fromEntries(WEDGES.map((w) => [w, Math.floor(r() * 10)]))
        : null;
      const id = `bench-b-${i}`;
      batch.push({
        id,
        name,
        category: CATEGORIES[Math.floor(r() * CATEGORIES.length)],
        country,
        region: regions.length && r() < 0.8 ? regions[Math.floor(r() * regions.length)] : null,
        distilleryId: distilleryIds[Math.floor(r() * distilleryIds.length)],
        ageYears: age,
        avgPrice: 20 + Math.floor(r() * 180),
        flavorProfile: profile,
        status,
        submittedBy: status === "user_submitted" ? "bench-other" : null,
      });
      if (r() < 0.3) aliases.push({ id: `bench-a-${i}`, bottleId: id, alias: `${brand.slice(0, 4)} ${age ?? ""}`.trim() });
    }
    await db.insert(schema.bottles).values(batch).onConflictDoNothing();
    if (aliases.length) await db.insert(schema.bottleAliases).values(aliases).onConflictDoNothing();
    have += batch.length;
    if (have % 20_000 < 1000) console.error(`  … ${have}/${SCALE} bottles (${Math.round((Date.now() - started) / 1000)}s)`);
  }
}

/** Give the bench user a palate (pours) and a small shelf, idempotently. */
async function ensureBenchUser(db: DB): Promise<void> {
  const seedIds = ["buffalo-trace", "lagavulin-16", "laphroaig-10", "redbreast-12", "eagle-rare-10"];
  const existing = await db.select({ id: schema.bottles.id }).from(schema.bottles)
    .where(sql`${schema.bottles.id} in (${sql.join(seedIds.map((s) => sql`${s}`), sql`, `)})`);
  for (const [k, { id }] of existing.entries()) {
    await db.insert(schema.pours)
      .values({ id: `bench-pour-${k}`, userId: "bench-user", bottleId: id, rating: 4 + (k % 2), amountMl: 30 })
      .onConflictDoNothing();
    await db.insert(schema.userBottles)
      .values({ id: `bench-ub-${k}`, userId: "bench-user", bottleId: id, relationship: "own" })
      .onConflictDoNothing();
  }
}

async function time(label: string, fn: () => Promise<unknown>): Promise<void> {
  await fn(); // warm the plan cache and the buffer pool
  const samples: number[] = [];
  let out: unknown;
  for (let k = 0; k < RUNS; k++) {
    const t = performance.now();
    out = await fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  const size = Array.isArray(out) ? ` rows=${out.length}` : "";
  console.log(`${label.padEnd(34)} p50=${p(0.5).toFixed(1).padStart(7)}ms  p95=${p(0.95).toFixed(1).padStart(7)}ms${size}`);
}

async function main(): Promise<void> {
  const url = resolveDbUrl();
  const db = createDb(url);
  await migrateDb(db, url);
  await ensureScaledCatalog(db);
  await ensureBenchUser(db);
  await db.execute(sql`ANALYZE`);

  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.bottles);
  console.log(`# ${isPostgresUrl(url) ? "postgres" : "pglite"} · ${Number(n)} bottles · ${RUNS} runs each\n`);

  for (const q of ["eagle rare", "lagavulin 16", "ecbp", "weller sr", "buffalo", "lafroig", "glenfidich 12", "johnny walker blue", "zzzz9999"]) {
    await time(`search "${q}"`, () => searchBottles(db, q, { viewerId: "bench-user" }));
  }
  await time("recommend discovery (end to end)", () => recommendBottles(db, "bench-user", { mode: "discovery" }));
  await time("getPassport", () => getPassport(db, "bench-user"));
  await closeDb(db);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
