import Link from "next/link";
import { Search } from "lucide-react";
import { hasMonthData, type DashboardData } from "@/lib/dashboard";
import { FLAVOR_WHEEL, leafLabel } from "@/lib/flavor-wheel";
import { warmify } from "@/components/wheel-geometry";
import { FillSpine, spineTone } from "@/components/fill-spine";
import { UserAvatar } from "@/components/user-avatar";

const WEDGES = new Map(FLAVOR_WHEEL.map((w) => [w.id, w]));

function wedgeLabel(wedgeId: string | null): string | null {
  return wedgeId ? WEDGES.get(wedgeId)?.label ?? null : null;
}

/**
 * The month in plain facts: bottles tasted, new bottles, the top note. Never
 * how much or how often anything was poured (AGENTS.md guardrails) — and
 * never a sentence about a blank page. Returns null when there is nothing to say.
 */
export function monthFacts(data: DashboardData): string | null {
  const parts: string[] = [];
  if (data.bottlesNoted > 0) parts.push(`${data.bottlesNoted} bottle${data.bottlesNoted === 1 ? "" : "s"} tasted`);
  if (data.newBottles > 0) parts.push(`${data.newBottles} new on the shelf`);
  const note = data.topNoteLeafId ? leafLabel(data.topNoteLeafId) : null;
  if (note) parts.push(`top note: ${note.toLowerCase()}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The family behind the month's top flavors, as a short secondary line. */
function flavorLine(data: DashboardData): string | null {
  const rising = wedgeLabel(data.risingWedgeId);
  if (!rising) return null;
  if (data.hadPrevMonth) return `${rising} is up since ${data.prevMonthName}.`;
  return `${rising} led your notes this month.`;
}

function StatTile({ value, label, sub, href }: { value: string; label: string; sub?: string; href?: string }) {
  const body = (
    <>
      <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 truncate font-display text-[16px] font-semibold leading-tight">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11.5px] leading-tight text-accent">{sub}</div>}
    </>
  );
  return href ? (
    <Link href={href} className="card-flat block min-w-0 flex-1 p-3 transition-colors hover:bg-surface-raised">
      {body}
    </Link>
  ) : (
    <div className="card-flat min-w-0 flex-1 p-3">{body}</div>
  );
}

/**
 * Home's first block: the month in review, in plain facts. Sections with no
 * data are hidden — no empty tiles and no grey placeholder bars (owner
 * feedback 2026-10-29). With nothing logged this month it collapses to one
 * plain line ("October · no tastings yet"); Home's "Start here" block
 * carries the next steps instead.
 *
 * "Running low" is inventory news rather than a month in review: it appears
 * only when a bottle actually is low, with or without month data.
 */
export function Dashboard({
  data,
  userName,
  userImage,
}: {
  data: DashboardData;
  userName: string;
  userImage?: string | null;
}) {
  const hasData = hasMonthData(data);
  const facts = monthFacts(data);
  const flavor = flavorLine(data);
  const maxShare = data.topCategories[0]?.sharePct ?? 0;
  const topWedge = data.topCategories[0] ? WEDGES.get(data.topCategories[0].wedgeId) : undefined;

  return (
    <section aria-label="Your month" className="flex flex-col gap-4">
      <div>
        <header className="flex items-center justify-between gap-3">
          <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
            {hasData ? data.monthName : `${data.monthName} · no tastings yet`}
          </h2>
          <UserAvatar name={userName} image={userImage} size={32} />
        </header>
        {facts && (
          <p data-testid="month-facts" className="mt-1.5 font-display text-[20px] font-medium leading-snug">
            {facts}
          </p>
        )}
        {flavor && <p className="mt-1 text-sm text-muted">{flavor}</p>}
      </div>

      {(data.favoriteBottle || topWedge || data.agreement != null) && (
        <div className="flex gap-2">
          {data.favoriteBottle && (
            <StatTile
              label="Favourite"
              value={data.favoriteBottle.name}
              sub={`★ ${data.favoriteBottle.rating.toFixed(1)}`}
              href={`/bottles/${data.favoriteBottle.bottleId}`}
            />
          )}
          {topWedge && (
            <StatTile label="Top flavor" value={topWedge.label} sub={`${data.topCategories[0].sharePct}% of your notes`} />
          )}
          {data.agreement != null && (
            <StatTile label="You and the label" value={`${Math.round(data.agreement * 100)}% agree`} />
          )}
        </div>
      )}

      {data.topCategories.length > 1 && (
        <div>
          <h3 className="section-label mb-2.5">Flavors this month</h3>
          <ul className="flex flex-col gap-2">
            {data.topCategories.map((cat) => {
              const wedge = WEDGES.get(cat.wedgeId);
              return (
                <li key={cat.wedgeId} className="flex items-center gap-3">
                  <span className="w-[104px] shrink-0 truncate text-xs text-foreground/85">
                    {wedge?.label ?? cat.wedgeId}
                  </span>
                  <span
                    className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full"
                    style={{ backgroundColor: "#1b2a21" }}
                  >
                    <span
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{
                        width: `${maxShare > 0 ? (cat.sharePct / maxShare) * 100 : 0}%`,
                        backgroundColor: wedge ? warmify(wedge.color) : "var(--muted)",
                      }}
                    />
                  </span>
                  <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted tabular-nums">
                    {cat.sharePct}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Inventory, and only when there IS inventory news: an empty "Nothing
          running low." is a row of chrome reporting a non-event, and it sat
          directly under the month's headline where the eye lands first. The
          zero state shows nothing here. */}
      {data.runningLow.length > 0 && (
        <div>
          <h3 className="section-label mb-2.5">Running low</h3>
          <ul className="flex flex-col gap-2">
            {data.runningLow.map((row) => (
              <li
                key={row.userBottleId}
                className="flex items-stretch gap-[13px] rounded-2xl border px-3.5 py-3"
                style={{ borderColor: "#26392d", background: "rgba(238,231,214,.03)" }}
              >
                <FillSpine level={row.fillLevel} tone={spineTone(row.bottleId)} className="self-stretch" />
                <Link href={`/bottles/${row.bottleId}`} className="min-w-0 flex-1 self-center">
                  <span className="block truncate text-[14.5px] font-semibold leading-[1.25]">
                    {row.name}
                  </span>
                  {/* Level only. A "~N pours to go" countdown would turn what
                      is left in the bottle into a target to finish. */}
                  <span className="mt-0.5 block text-xs text-muted">{row.fillLevel}% left</span>
                </Link>
                {/* The action here is restocking, not drinking. */}
                <Link
                  href={`/search?q=${encodeURIComponent(row.name)}`}
                  className="tap-target inline-flex min-h-9 shrink-0 items-center gap-1.5 self-center rounded-full border border-border-subtle px-3 text-xs font-medium text-muted transition-colors hover:text-foreground"
                >
                  <Search size={14} strokeWidth={1.8} aria-hidden />
                  Restock
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

    </section>
  );
}
