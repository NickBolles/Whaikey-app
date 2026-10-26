import type { FlavorProfileTier } from "@/db/schema";
import type { DayEnriched } from "@/lib/enrich/budget";

/**
 * Two small inline-SVG charts for /admin/enrichment (no chart library):
 * daily model spend against the hard cap, and profiles written per day by
 * provenance tier. Server-rendered; every bar carries a <title> tooltip and
 * each figure has a text summary for screen readers.
 */

const W = 300;
const H = 90;
const PAD_TOP = 6;
const PAD_BOTTOM = 14;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;

const usd = (v: number) => `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
const short = (day: string) => day.slice(5).replace("-", "/");

/** Tier → colour from the theme, strongest provenance darkest. */
export const TIER_STYLE: Record<FlavorProfileTier, { label: string; className: string }> = {
  community: { label: "community", className: "fill-success" },
  model_web: { label: "model + web", className: "fill-accent" },
  model: { label: "model", className: "fill-accent-deep" },
  keyword: { label: "keyword", className: "fill-muted" },
};
const STACK_ORDER: FlavorProfileTier[] = ["keyword", "model", "model_web", "community"];

function XLabels({ days }: { days: string[] }) {
  if (days.length === 0) return null;
  const step = W / days.length;
  const picks = [0, Math.floor((days.length - 1) / 2), days.length - 1];
  return (
    <>
      {[...new Set(picks)].map((i, n) => (
        <text
          key={i}
          x={n === 0 ? 0 : n === picks.length - 1 ? W : i * step + step / 2}
          y={H - 2}
          textAnchor={n === 0 ? "start" : n === picks.length - 1 ? "end" : "middle"}
          className="fill-muted"
          fontSize={8}
        >
          {short(days[i])}
        </text>
      ))}
    </>
  );
}

export function SpendChart({ series, capUsd }: { series: Array<{ day: string; usd: number; calls: number }>; capUsd: number }) {
  const max = Math.max(capUsd * 1.15, ...series.map((d) => d.usd), 0.01);
  const y = (v: number) => PAD_TOP + PLOT_H - (v / max) * PLOT_H;
  const step = W / Math.max(series.length, 1);
  const bw = Math.max(step - 2, 1);
  const total = series.reduce((s, d) => s + d.usd, 0);
  const overCap = series.filter((d) => d.usd > capUsd).length;
  return (
    <figure className="flex flex-col gap-1" data-testid="enrich-spend-chart">
      <figcaption className="flex justify-between text-xs text-muted">
        <span>Daily spend vs cap · last {series.length} days</span>
        <span className="tabular-nums">{usd(total)} total</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto rounded-lg border border-border-subtle bg-surface"
        role="img"
        aria-label={`Daily enrichment spend over the last ${series.length} days: ${usd(total)} in total, cap ${usd(capUsd)} per day, ${overCap} day${overCap === 1 ? "" : "s"} over the cap.`}
      >
        {series.map((d, i) => {
          const h = Math.max(PAD_TOP + PLOT_H - y(d.usd), d.usd > 0 ? 1 : 0);
          return (
            <rect
              key={d.day}
              x={i * step + 1}
              y={PAD_TOP + PLOT_H - h}
              width={bw}
              height={h}
              className={d.usd > capUsd ? "fill-danger" : "fill-accent"}
            >
              <title>{`${d.day} · ${usd(d.usd)} · ${d.calls} call${d.calls === 1 ? "" : "s"}`}</title>
            </rect>
          );
        })}
        <line x1={0} x2={W} y1={y(capUsd)} y2={y(capUsd)} className="stroke-danger" strokeWidth={0.75} strokeDasharray="3 2" />
        <text x={W - 2} y={y(capUsd) - 2} textAnchor="end" fontSize={8} className="fill-danger">
          cap {usd(capUsd)}
        </text>
        <line x1={0} x2={W} y1={PAD_TOP + PLOT_H} y2={PAD_TOP + PLOT_H} className="stroke-border" strokeWidth={0.5} />
        <XLabels days={series.map((d) => d.day)} />
      </svg>
    </figure>
  );
}

export function EnrichedChart({ series }: { series: DayEnriched[] }) {
  const max = Math.max(...series.map((d) => d.total), 1);
  const step = W / Math.max(series.length, 1);
  const bw = Math.max(step - 2, 1);
  const totals = Object.fromEntries(STACK_ORDER.map((t) => [t, series.reduce((s, d) => s + d.byTier[t], 0)])) as Record<FlavorProfileTier, number>;
  const total = series.reduce((s, d) => s + d.total, 0);
  return (
    <figure className="flex flex-col gap-1" data-testid="enrich-tier-chart">
      <figcaption className="flex justify-between text-xs text-muted">
        <span>Profiles written per day by tier</span>
        <span className="tabular-nums">{total.toLocaleString("en-US")} bottles</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto rounded-lg border border-border-subtle bg-surface"
        role="img"
        aria-label={`Profiles written over the last ${series.length} days: ${STACK_ORDER.map((t) => `${totals[t]} ${TIER_STYLE[t].label}`).join(", ")}.`}
      >
        {series.map((d, i) => {
          let top = PAD_TOP + PLOT_H;
          return (
            <g key={d.day}>
              <title>{`${d.day} · ${d.total} · ${STACK_ORDER.filter((t) => d.byTier[t] > 0).map((t) => `${TIER_STYLE[t].label} ${d.byTier[t]}`).join(", ") || "none"}`}</title>
              {STACK_ORDER.map((t) => {
                const n = d.byTier[t];
                if (n === 0) return null;
                const h = Math.max((n / max) * PLOT_H, 1);
                top -= h;
                return <rect key={t} x={i * step + 1} y={top} width={bw} height={h} className={TIER_STYLE[t].className} />;
              })}
            </g>
          );
        })}
        <text x={2} y={PAD_TOP + 6} fontSize={8} className="fill-muted">
          {max.toLocaleString("en-US")}
        </text>
        <line x1={0} x2={W} y1={PAD_TOP + PLOT_H} y2={PAD_TOP + PLOT_H} className="stroke-border" strokeWidth={0.5} />
        <XLabels days={series.map((d) => d.day)} />
      </svg>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" aria-label="Tiers">
        {[...STACK_ORDER].reverse().map((t) => (
          <li key={t} className="flex items-center gap-1">
            <svg width="8" height="8" aria-hidden="true">
              <rect width="8" height="8" rx="1" className={TIER_STYLE[t].className} />
            </svg>
            {TIER_STYLE[t].label} <span className="tabular-nums text-foreground">{totals[t].toLocaleString("en-US")}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
