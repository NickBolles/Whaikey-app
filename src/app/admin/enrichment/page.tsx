import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { isOperator } from "@/lib/operator";
import { flavorCoverage } from "@/lib/ingest/flavor-tiers";
import { enrichedByDay, getSettings, spendByDay, spendByRun, spendSeries, spendSince, utcMonthStart } from "@/lib/enrich/budget";
import { recentRuns } from "@/lib/enrich/batch";
import { enrichEnabledByEnv, getEnrichProvider } from "@/lib/enrich/providers";
import { queueStats, recentJobs } from "@/lib/enrich/queue";
import { POPULAR_REFRESH_TOP, topPopularBottles } from "@/lib/popularity";
import { EnrichedChart, SpendChart } from "./charts";
import { EnrichmentControls } from "./controls";

export const dynamic = "force-dynamic";

const num = (v: number) => v.toLocaleString("en-US");
const usd = (v: number) => `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
const when = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) + "Z" : "–");

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-border-subtle px-3 py-2">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted">
      {children}
    </h2>
  );
}

/**
 * Flavor enrichment (docs/DATA_SOURCES.md §2.4c) — operator only. Coverage by
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
  const [coverage, settings, stats, jobs, runs, days, today, monthToDate, spend30, enriched30, popular] = await Promise.all([
    flavorCoverage(db),
    getSettings(db),
    queueStats(db),
    recentJobs(db, 25),
    recentRuns(db, 15),
    spendByDay(db, 14),
    spendSince(db),
    spendSince(db, utcMonthStart()),
    spendSeries(db, 30),
    enrichedByDay(db, 30),
    topPopularBottles(db, 10),
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
          <Stat label="Today (UTC)" value={usd(today)} hint={`cap ${usd(settings.dailyBudgetUsd)} · ${Math.round((today / Math.max(settings.dailyBudgetUsd, 0.01)) * 100)}% used`} />
          <Stat label="Month to date" value={usd(monthToDate)} hint={`max ${usd(settings.dailyBudgetUsd * 31)}/mo at this cap`} />
          <Stat label="Queue" value={num(stats.queued)} hint={`${num(stats.due)} due · ${num(stats.running)} running`} />
          <Stat label="Done · failed" value={`${num(stats.done)} · ${num(stats.failed)}`} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SpendChart series={spend30} capUsd={settings.dailyBudgetUsd} />
          <EnrichedChart series={enriched30} />
        </div>
        <div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-xs">
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
        </table></div>
      </section>

      <section aria-labelledby="popular" className="flex flex-col gap-2">
        <H2 id="popular">Most looked-for bottles</H2>
        <p className="text-xs text-muted">
          Popularity = pours, shelf/wishlist adds, scans, search appearances and page opens (90 days) plus retail breadth. The top{" "}
          {num(POPULAR_REFRESH_TOP)} get web-grounded refreshes first, including untracked legacy profiles.
        </p>
        <div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-xs" data-testid="enrich-popular">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 text-left font-normal">Bottle</th>
              <th className="py-1 pr-3 text-right font-normal">Score</th>
              <th className="py-1 pr-3 text-right font-normal">Searches · views · scans</th>
              <th className="py-1 text-left font-normal">Profile</th>
            </tr>
          </thead>
          <tbody>
            {popular.length === 0 && (
              <tr><td colSpan={4} className="py-1 text-muted">No signals yet.</td></tr>
            )}
            {popular.map((b) => (
              <tr key={b.id} className="border-t border-border-subtle">
                <td className="py-1 pr-3"><Link href={`/bottles/${b.id}`} className="text-accent hover:underline">{b.name}</Link></td>
                <td className="py-1 pr-3 text-right tabular-nums">{num(Math.round(b.popularity))}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{num(b.searches)} · {num(b.views)} · {num(b.scans)}</td>
                <td className="py-1">{b.tier ?? (b.legacy ? "legacy" : "none")}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <EnrichmentControls paused={settings.paused} dailyBudgetUsd={settings.dailyBudgetUsd} live={enabled && provider != null} failed={stats.failed} />

      <section aria-labelledby="runs" className="flex flex-col gap-2">
        <H2 id="runs">Recent runs</H2>
        <div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-xs">
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
        </table></div>
      </section>

      <section aria-labelledby="jobs" className="flex flex-col gap-2">
        <H2 id="jobs">Jobs</H2>
        <div className="overflow-x-auto"><table className="w-full min-w-[30rem] text-xs">
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
        </table></div>
      </section>
    </div>
  );
}
