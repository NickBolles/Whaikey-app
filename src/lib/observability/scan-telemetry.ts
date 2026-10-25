import { and, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { schema } from "@/db";
import type { ScanKind, ScanOutcome, ScanSource } from "@/db/schema";
import { reportInBackground } from "./errors";

/**
 * Scan funnel telemetry and the catalog's barcode coverage (M0.5).
 *
 * Same contract as `analytics.ts`: first-party, server-side, and **recording
 * can never break the scan** — every write swallows its own failure. A scan
 * that 500s because a telemetry row could not be written would be the
 * measurement destroying the thing it measures.
 *
 * Privacy: rows carry no user id, session, IP, photo or label text (see the
 * `scan_events` table comment). The only identifier is a product barcode we
 * did not already know, which is what the coverage-gap list is made of.
 *
 * These are operator numbers, read behind `isOperator` on /admin/scan.
 */

export interface ScanEventInput {
  kind: ScanKind;
  outcome: ScanOutcome;
  source: ScanSource;
  upc?: string | null;
  resultCount?: number;
  confirmRank?: number | null;
  latencyMs?: number | null;
}

export async function recordScanEvent(db: DB, event: ScanEventInput): Promise<void> {
  try {
    // A known barcode is never stored; only gaps are (`candidates` / `miss`).
    const keepUpc = event.kind === "barcode" && (event.outcome === "candidates" || event.outcome === "miss");
    await db.insert(schema.scanEvents).values({
      id: crypto.randomUUID(),
      kind: event.kind,
      outcome: event.outcome,
      source: event.source,
      upc: keepUpc ? (event.upc ?? null) : null,
      resultCount: Math.max(0, Math.round(event.resultCount ?? 0)),
      confirmRank: event.confirmRank ?? null,
      latencyMs: event.latencyMs == null ? null : Math.max(0, Math.round(event.latencyMs)),
    });
  } catch (err) {
    console.error(`[scan-telemetry] failed to record ${event.kind}/${event.outcome}`, err);
    reportInBackground(err, { where: "scan-telemetry/recordScanEvent", tags: { kind: event.kind } });
  }
}

const DAY_MS = 86_400_000;

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export interface ScanFunnel {
  attempts: number;
  matched: number;
  candidates: number;
  miss: number;
  confirmed: number;
  /** matched / attempts — the barcode number that matters (barcode only; 0 for label). */
  ownHitRate: number | null;
  /** (matched + candidates) / attempts — the person had something to tap. */
  resolutionRate: number | null;
  /** confirmed / attempts. */
  confirmationRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

export interface ScanMetrics {
  since: Date;
  until: Date;
  barcode: ScanFunnel & {
    /** Of confirmed barcode scans: our top own match was the right bottle. */
    confirmedTopMatchRate: number | null;
    /** Of confirmed barcode scans: the bottle was not among our own matches. */
    confirmedOutsideOwnRate: number | null;
    bySource: Array<{ source: ScanSource; outcome: ScanOutcome; count: number }>;
  };
  label: ScanFunnel;
  /** Most-scanned barcodes we could not map, for an operator to fill in. */
  topUnmappedUpcs: Array<{ upc: string; scans: number; misses: number }>;
}

interface Row {
  kind: ScanKind;
  outcome: ScanOutcome;
  source: ScanSource;
  count: number;
}

function funnel(rows: Row[], kind: ScanKind, latency: { p50: number | null; p95: number | null }): ScanFunnel {
  const n = (outcome: ScanOutcome) =>
    rows.filter((r) => r.kind === kind && r.outcome === outcome).reduce((s, r) => s + r.count, 0);
  const matched = n("matched");
  const candidates = n("candidates");
  const miss = n("miss");
  const confirmed = n("confirmed");
  const attempts = matched + candidates + miss;
  return {
    attempts,
    matched,
    candidates,
    miss,
    confirmed,
    ownHitRate: kind === "barcode" ? ratio(matched, attempts) : null,
    resolutionRate: ratio(matched + candidates, attempts),
    confirmationRate: ratio(confirmed, attempts),
    latencyP50Ms: latency.p50,
    latencyP95Ms: latency.p95,
  };
}

/** The scan funnel over `[since, until)` — 30 days by default. */
export async function scanMetrics(db: DB, opts: { since?: Date; until?: Date } = {}): Promise<ScanMetrics> {
  const until = opts.until ?? new Date();
  const since = opts.since ?? new Date(until.getTime() - 30 * DAY_MS);
  const e = schema.scanEvents;
  const window = and(gte(e.createdAt, since), lt(e.createdAt, until));

  const [rows, latencies, ranks, gaps] = await Promise.all([
    db
      .select({ kind: e.kind, outcome: e.outcome, source: e.source, count: sql<number>`count(*)::int` })
      .from(e)
      .where(window)
      .groupBy(e.kind, e.outcome, e.source),
    db
      .select({
        kind: e.kind,
        p50: sql<number | null>`percentile_cont(0.5) within group (order by ${e.latencyMs})`,
        p95: sql<number | null>`percentile_cont(0.95) within group (order by ${e.latencyMs})`,
      })
      .from(e)
      .where(and(window, isNotNull(e.latencyMs), sql`${e.outcome} <> 'confirmed'`))
      .groupBy(e.kind),
    db
      .select({
        top: sql<number>`count(*) filter (where ${e.confirmRank} = 0)::int`,
        outside: sql<number>`count(*) filter (where ${e.confirmRank} is null)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(e)
      .where(and(window, sql`${e.kind} = 'barcode'`, sql`${e.outcome} = 'confirmed'`)),
    db
      .select({
        upc: sql<string>`${e.upc}`,
        scans: sql<number>`count(*)::int`,
        misses: sql<number>`count(*) filter (where ${e.outcome} = 'miss')::int`,
      })
      .from(e)
      .where(and(window, isNotNull(e.upc)))
      .groupBy(e.upc)
      .orderBy(sql`count(*) desc`, e.upc)
      .limit(25),
  ]);

  const typed = rows.map((r) => ({ ...r, count: Number(r.count) })) as Row[];
  const lat = (kind: ScanKind) => {
    const row = latencies.find((l) => l.kind === kind);
    const num = (v: unknown) => (v == null ? null : Math.round(Number(v)));
    return { p50: num(row?.p50), p95: num(row?.p95) };
  };
  const rank = ranks[0] ?? { top: 0, outside: 0, total: 0 };

  return {
    since,
    until,
    barcode: {
      ...funnel(typed, "barcode", lat("barcode")),
      confirmedTopMatchRate: ratio(Number(rank.top), Number(rank.total)),
      confirmedOutsideOwnRate: ratio(Number(rank.outside), Number(rank.total)),
      bySource: typed
        .filter((r) => r.kind === "barcode")
        .map(({ source, outcome, count }) => ({ source, outcome, count }))
        .sort((a, b) => b.count - a.count),
    },
    label: funnel(typed, "label", lat("label")),
    topUnmappedUpcs: gaps.map((g) => ({ upc: g.upc, scans: Number(g.scans), misses: Number(g.misses) })),
  };
}

export interface CatalogCoverage {
  /** Bottles anyone can scan to: verified + imported (pending submissions excluded). */
  bottles: number;
  byStatus: Record<string, number>;
  withUpc: number;
  /** At least one barcode mapping a person has confirmed. */
  withConfirmedUpc: number;
  withFlavorProfile: number;
  withImage: number;
  upcRate: number | null;
  confirmedUpcRate: number | null;
  flavorProfileRate: number | null;
  /** Barcode rows by provenance (iowa, bc, user, seed, …). */
  upcsBySource: Array<{ source: string; count: number }>;
}

/** How much of the catalog a barcode scan can land on, and how much of it is enriched. */
export async function catalogCoverage(db: DB): Promise<CatalogCoverage> {
  const b = schema.bottles;
  const u = schema.bottleUpcs;
  const [statusRows, [cov], upcRows] = await Promise.all([
    db.select({ status: b.status, count: sql<number>`count(*)::int` }).from(b).groupBy(b.status),
    db
      .select({
        bottles: sql<number>`count(*)::int`,
        // Spelled out: inside a correlated subquery drizzle renders a bare
        // column name, and an unqualified "id" would bind to bottle_upcs.id.
        withUpc: sql<number>`count(*) filter (where exists (select 1 from bottle_upcs u where u.bottle_id = bottles.id))::int`,
        withConfirmedUpc: sql<number>`count(*) filter (where exists (select 1 from bottle_upcs u where u.bottle_id = bottles.id and u.confirmed_count > 0))::int`,
        withFlavorProfile: sql<number>`count(*) filter (where ${b.flavorProfile} is not null)::int`,
        withImage: sql<number>`count(*) filter (where ${b.imageUrl} is not null)::int`,
      })
      .from(b)
      .where(sql`${b.status} <> 'user_submitted'`),
    db.select({ source: u.source, count: sql<number>`count(*)::int` }).from(u).groupBy(u.source),
  ]);
  const bottles = Number(cov?.bottles ?? 0);
  const withUpc = Number(cov?.withUpc ?? 0);
  const withConfirmedUpc = Number(cov?.withConfirmedUpc ?? 0);
  const withFlavorProfile = Number(cov?.withFlavorProfile ?? 0);
  return {
    bottles,
    byStatus: Object.fromEntries(statusRows.map((r) => [r.status, Number(r.count)])),
    withUpc,
    withConfirmedUpc,
    withFlavorProfile,
    withImage: Number(cov?.withImage ?? 0),
    upcRate: ratio(withUpc, bottles),
    confirmedUpcRate: ratio(withConfirmedUpc, bottles),
    flavorProfileRate: ratio(withFlavorProfile, bottles),
    upcsBySource: upcRows
      .map((r) => ({ source: String(r.source), count: Number(r.count) }))
      .sort((a, b) => b.count - a.count),
  };
}
