/**
 * External barcode providers: registry, permanent cache, daily budget and
 * backoff (M1 / Track A6).
 *
 * Order of resolution for a barcode is own `bottle_upcs` → pending crowd
 * confirmations → **this module**. Inside it, providers are tried in order
 * (licensed whisky API → UPCitemdb → Open Food Facts), and each one is
 * guarded three ways so a capped free tier degrades to "skip this provider"
 * instead of failing scans or getting the IP banned:
 *
 * 1. **Cache.** Every answer is stored in `upc_lookup_cache` — hits with no
 *    expiry (permanent) unless the provider's terms need one, misses for a
 *    while — so a barcode costs at most one request per provider, ever.
 * 2. **Budget.** `upc_provider_usage` counts requests per UTC day and per
 *    minute. UPCitemdb's trial is 100/day and 6/minute per IP; the default
 *    budget leaves headroom (95/day, 5/min) so we stop before they do.
 * 3. **Backoff.** A 429/5xx/timeout sets `backoff_until` with exponential
 *    growth (honouring Retry-After / X-RateLimit-Reset); the provider is
 *    skipped until then.
 *
 * Provider data stays isolated: titles are only used to fuzzy-search our own
 * catalog and are never merged into `bottles`/`bottle_upcs` (ODbL / ToS).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { upcLookupCache, upcProviderUsage, type UpcProvider } from "@/db/schema";

const DAY_MS = 86_400_000;

/** Env lookups are injectable for tests; `process.env` satisfies it. */
type Env = Record<string, string | undefined>;
const MINUTE_MS = 60_000;
const TIMEOUT_MS = 3000;
const MAX_INT = 2_147_483_647;

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
}

export interface ProviderDef {
  id: UpcProvider;
  /** Null when unconfigured or switched off. */
  request(upc: string, env: Env): ProviderRequest | null;
  /** The product name in a successful body, or null for "not found". */
  parse(body: unknown): string | null;
  /** Requests per UTC day; null = unmetered. */
  perDay(env: Env): number | null;
  /** Requests per minute; null = unmetered. */
  perMinute(env: Env): number | null;
  /** How long a hit is kept; null = permanently. */
  hitTtlMs: number | null;
  /** How long a miss is kept before the provider is asked again. */
  missTtlMs: number;
}

function intEnv(env: Env, key: string, fallback: number | null): number | null {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "unlimited") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** First entry of an items/results/data/spirits array (or the body), reading name/full_name/title. */
export function extractProductName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const list = ["items", "results", "data", "spirits"]
    .map((k) => body[k])
    .find((v): v is unknown[] => Array.isArray(v));
  const first = (list ? list[0] : payload) as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return null;
  const name = [first.name, first.full_name, first.title].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return name?.trim() ?? null;
}

export const PROVIDERS: readonly ProviderDef[] = [
  {
    // A licensed whiskey-specialised API, configured entirely by env
    // (docs/SOURCING_AT_SCALE.md §3.2). Unset ⇒ skipped.
    id: "whiskyapi",
    request(upc, env): ProviderRequest | null {
      const template = env.WHAIKEY_WHISKY_UPC_URL;
      if (!template || !template.includes("{upc}")) return null;
      const key = env.WHAIKEY_WHISKY_UPC_KEY;
      return {
        url: template.replace("{upc}", encodeURIComponent(upc)),
        headers: { accept: "application/json", ...(key ? { "API-Key": key } : {}) },
      };
    },
    parse: extractProductName,
    perDay: (env) => intEnv(env, "WHAIKEY_WHISKY_UPC_DAILY_BUDGET", null),
    perMinute: () => null,
    hitTtlMs: null,
    missTtlMs: 7 * DAY_MS,
  },
  {
    // UPCitemdb: the paid `/prod/v1` when UPCITEMDB_KEY is set, otherwise
    // the free trial (100/day, 6/min per IP). WHAIKEY_UPCITEMDB=off disables.
    id: "upcitemdb",
    request(upc, env): ProviderRequest | null {
      if (env.WHAIKEY_UPCITEMDB === "off") return null;
      const key = env.UPCITEMDB_KEY;
      return key
        ? {
            url: `https://api.upcitemdb.com/prod/v1/lookup?upc=${encodeURIComponent(upc)}`,
            headers: { accept: "application/json", user_key: key, key_type: "3scale" },
          }
        : {
            url: `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`,
            headers: { accept: "application/json" },
          };
    },
    parse(body) {
      const items = (body as { items?: Array<{ title?: string }> } | null)?.items;
      const title = items?.[0]?.title?.trim();
      return title || null;
    },
    perDay: (env) => intEnv(env, "WHAIKEY_UPCITEMDB_DAILY_BUDGET", env.UPCITEMDB_KEY ? null : 95),
    perMinute: (env) => intEnv(env, "WHAIKEY_UPCITEMDB_PER_MINUTE", env.UPCITEMDB_KEY ? null : 5),
    hitTtlMs: null,
    missTtlMs: 30 * DAY_MS,
  },
  {
    // Open Food Facts. ODbL: kept transient-ish (30-day hit cache, never
    // merged into the catalog). They ask for ≤100 product reads/minute.
    id: "openfoodfacts",
    request(upc, env): ProviderRequest | null {
      if (env.WHAIKEY_OPENFOODFACTS === "off") return null;
      return {
        url: `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json?fields=product_name,brands`,
        headers: { accept: "application/json", "user-agent": "Whaikey/0.1 (barcode lookup)" },
      };
    },
    parse(body) {
      const p = (body as { product?: { product_name?: string; brands?: string } } | null)?.product;
      const name = [p?.brands, p?.product_name]
        .map((s) => s?.trim())
        .filter(Boolean)
        .join(" ");
      return name || null;
    },
    perDay: (env) => intEnv(env, "WHAIKEY_OPENFOODFACTS_DAILY_BUDGET", null),
    perMinute: () => 60,
    hitTtlMs: 30 * DAY_MS,
    missTtlMs: 7 * DAY_MS,
  },
];

export interface LookupDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  env?: Env;
  providers?: readonly ProviderDef[];
}

export type ProviderOutcome =
  | "cache_hit"
  | "cache_miss"
  | "hit"
  | "miss"
  | "budget"
  | "backoff"
  | "throttled"
  | "error"
  | "disabled";

export interface ExternalUpcProduct {
  name: string;
  provider: UpcProvider;
  cached: boolean;
}

export interface LookupResult {
  product: ExternalUpcProduct | null;
  /** What happened at each provider, in order — for telemetry and tests. */
  trace: Array<{ provider: UpcProvider; outcome: ProviderOutcome }>;
}

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const minuteStart = (d: Date): Date => new Date(Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS);
const nextUtcMidnight = (d: Date): Date => new Date((Math.floor(d.getTime() / DAY_MS) + 1) * DAY_MS);

async function readCache(db: DB, provider: UpcProvider, upc: string, now: Date) {
  const [row] = await db
    .select()
    .from(upcLookupCache)
    .where(and(eq(upcLookupCache.provider, provider), eq(upcLookupCache.upc, upc)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

async function writeCache(
  db: DB,
  def: ProviderDef,
  upc: string,
  name: string | null,
  now: Date,
): Promise<void> {
  const ttl = name ? def.hitTtlMs : def.missTtlMs;
  const values = {
    provider: def.id,
    upc,
    found: name !== null,
    productName: name,
    fetchedAt: now,
    expiresAt: ttl == null ? null : new Date(now.getTime() + ttl),
  };
  await db
    .insert(upcLookupCache)
    .values(values)
    .onConflictDoUpdate({
      target: [upcLookupCache.provider, upcLookupCache.upc],
      set: { found: values.found, productName: values.productName, fetchedAt: now, expiresAt: values.expiresAt },
    });
}

/** The provider's live backoff, if any (looked up across days: a 429 at 23:59 still counts at 00:01). */
export async function activeBackoff(db: DB, provider: UpcProvider, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ until: upcProviderUsage.backoffUntil })
    .from(upcProviderUsage)
    .where(and(eq(upcProviderUsage.provider, provider), sql`${upcProviderUsage.backoffUntil} > ${now}`))
    .orderBy(desc(upcProviderUsage.backoffUntil))
    .limit(1);
  return row?.until ?? null;
}

/**
 * Atomically take one request from today's budget (and this minute's).
 * A single upsert whose update is conditional, so two concurrent scans cannot
 * both take the last request. Returns false when the budget is spent.
 */
export async function reserveRequest(
  db: DB,
  provider: UpcProvider,
  now: Date,
  limits: { perDay: number | null; perMinute: number | null },
): Promise<boolean> {
  const perDay = limits.perDay ?? MAX_INT;
  const perMinute = limits.perMinute ?? MAX_INT;
  if (perDay <= 0 || perMinute <= 0) return false;
  const minute = minuteStart(now);
  const u = upcProviderUsage;
  const rows = await db
    .insert(u)
    .values({ provider, day: utcDay(now), requests: 1, minuteStart: minute, minuteCount: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: [u.provider, u.day],
      set: {
        requests: sql`${u.requests} + 1`,
        minuteCount: sql`case when ${u.minuteStart} = ${minute} then ${u.minuteCount} + 1 else 1 end`,
        minuteStart: minute,
        updatedAt: now,
      },
      setWhere: sql`${u.requests} < ${perDay} and (${u.minuteStart} is distinct from ${minute} or ${u.minuteCount} < ${perMinute})`,
    })
    .returning({ requests: u.requests });
  return rows.length > 0;
}

/** Backoff after `failures` consecutive failures: 1, 2, 4 … minutes, capped at 6 h. */
export function backoffMs(failures: number): number {
  return Math.min(6 * 60 * MINUTE_MS, MINUTE_MS * 2 ** Math.max(0, failures - 1));
}

function retryAfter(res: Response, now: Date): Date | null {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return new Date(now.getTime() + secs * 1000);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return new Date(at);
  }
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    // Epoch seconds (UPCitemdb) or seconds-from-now; disambiguate by size.
    return new Date(reset > 1e9 ? reset * 1000 : now.getTime() + reset * 1000);
  }
  return null;
}

async function recordResult(
  db: DB,
  provider: UpcProvider,
  now: Date,
  status: number | null,
  failed: boolean,
  hinted: Date | null = null,
  throttledByDailyCap = false,
): Promise<void> {
  const u = upcProviderUsage;
  const day = utcDay(now);
  if (!failed) {
    await db
      .update(u)
      .set({ failures: 0, lastStatus: status, updatedAt: now })
      .where(and(eq(u.provider, provider), eq(u.day, day)));
    return;
  }
  const [row] = await db
    .select({ failures: u.failures })
    .from(u)
    .where(and(eq(u.provider, provider), eq(u.day, day)))
    .limit(1);
  const failures = (row?.failures ?? 0) + 1;
  let until = hinted ?? new Date(now.getTime() + backoffMs(failures));
  // A 429 from a per-day cap will not clear before the provider's day rolls.
  if (throttledByDailyCap && !hinted) until = nextUtcMidnight(now);
  await db
    .insert(u)
    .values({ provider, day, requests: 0, failures, backoffUntil: until, lastStatus: status, updatedAt: now })
    .onConflictDoUpdate({
      target: [u.provider, u.day],
      set: { failures, backoffUntil: until, lastStatus: status, updatedAt: now },
    });
}

/**
 * Look a barcode up across the providers, cheapest answer first. Never throws:
 * any failure is recorded and the next provider is tried; all failing is a
 * plain `null` product and the scan offers search / "add this bottle".
 */
export async function lookupExternalUpc(db: DB, upc: string, deps: LookupDeps = {}): Promise<LookupResult> {
  const doFetch = deps.fetch ?? fetch;
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? process.env;
  const trace: LookupResult["trace"] = [];

  for (const def of deps.providers ?? PROVIDERS) {
    const req = def.request(upc, env);
    if (!req) {
      trace.push({ provider: def.id, outcome: "disabled" });
      continue;
    }
    try {
      const cached = await readCache(db, def.id, upc, now);
      if (cached) {
        if (cached.found && cached.productName) {
          trace.push({ provider: def.id, outcome: "cache_hit" });
          return { product: { name: cached.productName, provider: def.id, cached: true }, trace };
        }
        trace.push({ provider: def.id, outcome: "cache_miss" });
        continue;
      }
      if (await activeBackoff(db, def.id, now)) {
        trace.push({ provider: def.id, outcome: "backoff" });
        continue;
      }
      const perDay = def.perDay(env);
      if (!(await reserveRequest(db, def.id, now, { perDay, perMinute: def.perMinute(env) }))) {
        trace.push({ provider: def.id, outcome: "budget" });
        continue;
      }
    } catch (err) {
      // The guard tables are bookkeeping: if they fail, skip this provider
      // rather than call it unmetered.
      console.error(`[upc-providers] guard failed for ${def.id}`, err);
      trace.push({ provider: def.id, outcome: "error" });
      continue;
    }

    let res: Response;
    try {
      res = await doFetch(req.url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: req.headers });
    } catch {
      await recordResult(db, def.id, now, null, true).catch(() => {});
      trace.push({ provider: def.id, outcome: "error" });
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      await recordResult(
        db,
        def.id,
        now,
        res.status,
        true,
        res.status === 429 ? retryAfter(res, now) : null,
        res.status === 429 && def.perDay(env) != null,
      ).catch(() => {});
      trace.push({ provider: def.id, outcome: res.status === 429 ? "throttled" : "error" });
      continue;
    }

    let name: string | null = null;
    if (res.ok) {
      try {
        name = def.parse(await res.json());
      } catch {
        // Non-JSON 200 (a parked domain, an HTML error page): a provider fault, not a miss.
        await recordResult(db, def.id, now, res.status, true).catch(() => {});
        trace.push({ provider: def.id, outcome: "error" });
        continue;
      }
    }
    // 2xx-without-item and 400/404 are both "this provider does not know it".
    await Promise.all([
      writeCache(db, def, upc, name, now),
      recordResult(db, def.id, now, res.status, false),
    ]).catch((err) => console.error(`[upc-providers] bookkeeping failed for ${def.id}`, err));
    if (name) {
      trace.push({ provider: def.id, outcome: "hit" });
      return { product: { name, provider: def.id, cached: false }, trace };
    }
    trace.push({ provider: def.id, outcome: "miss" });
  }
  return { product: null, trace };
}

export interface ProviderStatus {
  provider: UpcProvider;
  enabled: boolean;
  requestsToday: number;
  perDay: number | null;
  backoffUntil: Date | null;
  lastStatus: number | null;
  cachedHits: number;
  cachedMisses: number;
}

/** Today's budget use, backoff and cache size per provider — for /admin/scan. */
export async function providerStatus(db: DB, deps: Pick<LookupDeps, "now" | "env"> = {}): Promise<ProviderStatus[]> {
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? process.env;
  const usage = await db.select().from(upcProviderUsage).where(eq(upcProviderUsage.day, utcDay(now)));
  const cache = await db
    .select({
      provider: upcLookupCache.provider,
      hits: sql<number>`count(*) filter (where ${upcLookupCache.found})::int`,
      misses: sql<number>`count(*) filter (where not ${upcLookupCache.found})::int`,
    })
    .from(upcLookupCache)
    .groupBy(upcLookupCache.provider);
  const out: ProviderStatus[] = [];
  for (const def of PROVIDERS) {
    const u = usage.find((r) => r.provider === def.id);
    const c = cache.find((r) => r.provider === def.id);
    out.push({
      provider: def.id,
      enabled: def.request("000000000000", env) !== null,
      requestsToday: u?.requests ?? 0,
      perDay: def.perDay(env),
      backoffUntil: await activeBackoff(db, def.id, now),
      lastStatus: u?.lastStatus ?? null,
      cachedHits: Number(c?.hits ?? 0),
      cachedMisses: Number(c?.misses ?? 0),
    });
  }
  return out;
}
