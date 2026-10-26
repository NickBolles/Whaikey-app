import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import { flavorCoverage } from "@/lib/ingest/flavor-tiers";
import { getSettings, spendByDay, spendByRun, spendSince } from "@/lib/enrich/budget";
import { recentRuns } from "@/lib/enrich/batch";
import { enrichEnabledByEnv, getEnrichProvider } from "@/lib/enrich/providers";
import { queueStats, recentJobs } from "@/lib/enrich/queue";
import { EnrichmentControls } from "./controls";

export const dynamic = "force-dynamic";

const num = (v: number) => v.toLocaleString("en-US");
const usd = (v: number) => `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
const when = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) + "Z" : "–");

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-border-subtle px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-[11px] font-semibold uppercase tracking-wide text-muted">
      {children}
    </h2>
  );
}

/**
 * Flavor enrichment (docs/DATA_SOURCES.md §2.4b) — operator only. Coverage by
 * provenance tier, the live queue, recent batch runs, estimated spend per day
 * and per run, and the controls: daily cap, pause, run a batch now, retry
 * failures, re-enrich one bottle. Nothing here names a person.
 */
export default async function AdminEnrichmentPage() {
  const viewer = await getSessionUser();
  if (!isOperator(viewer)) notFound();

  const db = getDb();
  const provider = getEnrichProvider();
  const enabled = enrichEnabledByEnv();
  const [coverage, settings, stats, jobs, runs, days, today] = await Promise.all([
    flavorCoverage(db),
    getSettings(db),
    queueStats(db),
    recentJobs(db, 25),
    recentRuns(db, 15),
    spendByDay(db, 14),
    spendSince(db),
  ]);
  const runSpend = await spendByRun(db, runs.map((r) => r.id));

  return (
    <div className="px-3 py-4 max-w-4xl mx-auto w-full flex flex-col gap-4 text-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-xl font-semibold">Flavor enrichment</h1>
        <nav className="flex gap-3 text-xs">
          <Link href="/admin/scan" className="text-accent hover:underline">Scan →</Link>
          <Link href="/admin/submissions" className="text-accent hover:underline">Submissions →</Link>
        </nav>
      </header>

      <section aria-labelledby="provider" className="flex flex-col gap-2">
        <H2 id="provider">Provider</H2>
        {!provider ? (
          <p className="rounded-lg border border-border-subtle px-3 py-2" data-testid="enrich-provider-status">
            No provider key configured. Set <code>OPENAI_API_KEY</code> (or use <code>ANTHROPIC_API_KEY</code>), then{" "}
            <code>ENRICH_ENABLED=true</code>.
          </p>
        ) : (
          <p className="rounded-lg border border-border-subtle px-3 py-2" data-testid="enrich-provider-status">
            {provider.name} · quick <code>{provider.quickModel}</code> · web <code>{provider.webModel}</code> ·{" "}
            {enabled ? (settings.paused ? "paused" : "enabled") : <strong>ENRICH_ENABLED is off — nothing will call a model</strong>}
          </p>
        )}
      </section>

      <section aria-labelledby="coverage" className="flex flex-col gap-2">
        <H2 id="coverage">Coverage</H2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="With a profile" value={`${coverage.coveragePct}%`} hint={`${num(coverage.withProfile)} of ${num(coverage.bottles)}`} />
          {(["community", "model_web", "model", "keyword"] as const).map((t) => (
            <Stat key={t} label={t} value={num(coverage.byTier[t] ?? 0)} />
          ))}
          <Stat label="legacy (untracked)" value={num(coverage.legacy)} />
        </div>
      </section>

      <section aria-labelledby="spend" className="flex flex-col gap-2">
        <H2 id="spend">Spend (estimated)</H2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Today (UTC)" value={usd(today)} hint={`cap ${usd(settings.dailyBudgetUsd)}`} />
          <Stat label="Queue" value={num(stats.queued)} hint={`${num(stats.due)} due · ${num(stats.running)} running`} />
          <Stat label="Done" value={num(stats.done)} />
          <Stat label="Failed" value={num(stats.failed)} />
        </div>
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 text-left font-normal">Day</th>
              <th className="py-1 pr-3 text-right font-normal">Calls</th>
              <th className="py-1 pr-3 text-right font-normal">Failed</th>
              <th className="py-1 pr-3 text-right font-normal">Tokens in/out</th>
              <th className="py-1 pr-3 text-right font-normal">Searches</th>
              <th className="py-1 text-right font-normal">$</th>
            </tr>
          </thead>
          <tbody>
            {days.length === 0 && (
              <tr><td colSpan={6} className="py-1 text-muted">No model calls yet.</td></tr>
            )}
            {days.map((d) => (
              <tr key={d.day} className="border-t border-border-subtle">
                <td className="py-1 pr-3">{d.day}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{num(d.calls)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{num(d.failed)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{num(d.inputTokens)} / {num(d.outputTokens)}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{num(d.webSearches)}</td>
                <td className="py-1 text-right tabular-nums">{usd(d.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <EnrichmentControls paused={settings.paused} dailyBudgetUsd={settings.dailyBudgetUsd} live={enabled && provider != null} failed={stats.failed} />

      <section aria-labelledby="runs" className="flex flex-col gap-2">
        <H2 id="runs">Recent runs</H2>
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 text-left font-normal">Started</th>
              <th className="py-1 pr-3 text-left font-normal">Trigger</th>
              <th className="py-1 pr-3 text-left font-normal">Tiers</th>
              <th className="py-1 pr-3 text-left font-normal">Outcome</th>
              <th className="py-1 pr-3 text-left font-normal">Counts</th>
              <th className="py-1 text-right font-normal">$</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={6} className="py-1 text-muted">No runs yet.</td></tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-border-subtle align-top">
                <td className="py-1 pr-3 whitespace-nowrap">{when(r.startedAt)}</td>
                <td className="py-1 pr-3">{r.trigger}</td>
                <td className="py-1 pr-3">{r.tiers.join(", ")}</td>
                <td className="py-1 pr-3">{r.state}{r.stopReason && r.stopReason !== "done" ? ` (${r.stopReason})` : ""}{r.error ? ` — ${r.error}` : ""}</td>
                <td className="py-1 pr-3">{Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}</td>
                <td className="py-1 text-right tabular-nums">{usd(runSpend.get(r.id)?.usd ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="jobs" className="flex flex-col gap-2">
        <H2 id="jobs">Jobs</H2>
        <table className="w-full text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 text-left font-normal">Bottle</th>
              <th className="py-1 pr-3 text-left font-normal">Why</th>
              <th className="py-1 pr-3 text-left font-normal">State</th>
              <th className="py-1 pr-3 text-left font-normal">Steps</th>
              <th className="py-1 text-left font-normal">Created</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr><td colSpan={5} className="py-1 text-muted">No jobs yet.</td></tr>
            )}
            {jobs.map((j) => (
              <tr key={j.id} className="border-t border-border-subtle align-top">
                <td className="py-1 pr-3"><Link href={`/bottles/${j.bottleId}`} className="text-accent hover:underline">{j.bottleName}</Link></td>
                <td className="py-1 pr-3">{j.reason}</td>
                <td className="py-1 pr-3">{j.state}{j.waitingReason ? ` (${j.waitingReason})` : ""}{j.error ? ` — ${j.error}` : ""}{j.attempts > 0 ? ` · ${j.attempts} tries` : ""}</td>
                <td className="py-1 pr-3">{j.stepsDone.join(" → ") || "–"}</td>
                <td className="py-1 whitespace-nowrap">{when(j.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
