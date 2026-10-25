import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import { catalogCoverage, scanMetrics, type ScanFunnel } from "@/lib/observability/scan-telemetry";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v == null ? "–" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString("en-US"));
const ms = (v: number | null) => (v == null ? "–" : `${v.toLocaleString("en-US")} ms`);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-border-subtle px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

function FunnelRow({ name, f, own }: { name: string; f: ScanFunnel; own: boolean }) {
  return (
    <tr className="border-t border-border-subtle">
      <td className="py-1 pr-3 font-medium">{name}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{num(f.attempts)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{own ? pct(f.ownHitRate) : "–"}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{pct(f.resolutionRate)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{num(f.miss)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{pct(f.confirmationRate)}</td>
      <td className="py-1 pr-3 text-right tabular-nums">{ms(f.latencyP50Ms)}</td>
      <td className="py-1 text-right tabular-nums">{ms(f.latencyP95Ms)}</td>
    </tr>
  );
}

/**
 * Scan funnel and barcode coverage (M0.5) — operator only, like every other
 * page under /admin. The numbers come from anonymous `scan_events` rows and
 * plain catalog counts; nothing here names a person.
 */
export default async function AdminScanPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const viewer = await getSessionUser();
  if (!isOperator(viewer)) notFound();

  const { days: rawDays } = await searchParams;
  const days = Math.min(90, Math.max(1, Number.parseInt(rawDays ?? "30", 10) || 30));
  const db = getDb();
  const until = new Date();
  const [metrics, coverage] = await Promise.all([
    scanMetrics(db, { since: new Date(until.getTime() - days * 86_400_000), until }),
    catalogCoverage(db),
  ]);
  const b = metrics.barcode;

  return (
    <div className="px-3 py-4 max-w-4xl mx-auto w-full flex flex-col gap-4 text-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-xl font-semibold">Scan &amp; coverage</h1>
        <nav className="flex gap-3 text-xs">
          {[7, 30, 90].map((d) => (
            <Link
              key={d}
              href={`/admin/scan?days=${d}`}
              className={d === days ? "font-semibold text-foreground" : "text-accent hover:underline"}
            >
              {d}d
            </Link>
          ))}
          <Link href="/admin/reports" className="text-accent hover:underline">
            Reports →
          </Link>
          <Link href="/admin/submissions" className="text-accent hover:underline">
            Submissions →
          </Link>
          <Link href="/admin/feedback" className="text-accent hover:underline">
            Feedback →
          </Link>
        </nav>
      </header>

      <section aria-labelledby="coverage" className="flex flex-col gap-2">
        <h2 id="coverage" className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Catalog coverage
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Scannable bottles" value={num(coverage.bottles)} hint={Object.entries(coverage.byStatus).map(([k, v]) => `${k} ${num(v)}`).join(" · ")} />
          <Stat label="With a barcode" value={pct(coverage.upcRate)} hint={num(coverage.withUpc)} />
          <Stat label="User-confirmed barcode" value={pct(coverage.confirmedUpcRate)} hint={num(coverage.withConfirmedUpc)} />
          <Stat label="Flavor profile" value={pct(coverage.flavorProfileRate)} hint={num(coverage.withFlavorProfile)} />
        </div>
        <p className="text-xs text-muted">
          Barcode rows by source:{" "}
          {coverage.upcsBySource.length === 0
            ? "none"
            : coverage.upcsBySource.map((s) => `${s.source} ${num(s.count)}`).join(" · ")}
        </p>
      </section>

      <section aria-labelledby="funnel" className="flex flex-col gap-2">
        <h2 id="funnel" className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Scan funnel · last {days} days
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Barcode own-DB hit" value={pct(b.ownHitRate)} hint={`${num(b.matched)} of ${num(b.attempts)}`} />
          <Stat label="Barcode resolved" value={pct(b.resolutionRate)} hint="own + provider candidates" />
          <Stat label="Top match confirmed" value={pct(b.confirmedTopMatchRate)} hint={`of ${num(b.confirmed)} confirmations`} />
          <Stat label="Label scans (AI)" value={num(metrics.label.attempts)} hint={`${pct(metrics.label.resolutionRate)} gave candidates`} />
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 text-left font-normal">Kind</th>
              <th className="py-1 pr-3 text-right font-normal">Attempts</th>
              <th className="py-1 pr-3 text-right font-normal">Own hit</th>
              <th className="py-1 pr-3 text-right font-normal">Resolved</th>
              <th className="py-1 pr-3 text-right font-normal">Misses</th>
              <th className="py-1 pr-3 text-right font-normal">Confirmed</th>
              <th className="py-1 pr-3 text-right font-normal">p50</th>
              <th className="py-1 text-right font-normal">p95</th>
            </tr>
          </thead>
          <tbody>
            <FunnelRow name="Barcode" f={b} own />
            <FunnelRow name="Label" f={metrics.label} own={false} />
          </tbody>
        </table>
        <p className="text-xs text-muted">
          Barcode outcomes by source:{" "}
          {b.bySource.length === 0 ? "none yet" : b.bySource.map((s) => `${s.source}/${s.outcome} ${num(s.count)}`).join(" · ")}.
          Label attempts include live label-ID frames, so read the rate rather than the count. Confirmations without a
          barcode come from a label read or a search pick.
        </p>
      </section>

      <section aria-labelledby="gaps" className="flex flex-col gap-2">
        <h2 id="gaps" className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Most-scanned unmapped barcodes
        </h2>
        {metrics.topUnmappedUpcs.length === 0 ? (
          <p className="text-xs text-muted">No unmapped barcodes in this window.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-3 text-left font-normal">Barcode</th>
                <th className="py-1 pr-3 text-right font-normal">Scans</th>
                <th className="py-1 text-right font-normal">No candidates</th>
              </tr>
            </thead>
            <tbody>
              {metrics.topUnmappedUpcs.map((g) => (
                <tr key={g.upc} className="border-t border-border-subtle">
                  <td className="py-1 pr-3 font-mono">{g.upc}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{num(g.scans)}</td>
                  <td className="py-1 text-right tabular-nums">{num(g.misses)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
