import Link from "next/link";
import { ScanLine, Search } from "lucide-react";
import type { DashboardData } from "@/lib/dashboard";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import { warmify } from "@/components/wheel-geometry";
import { FillSpine, spineTone } from "@/components/fill-spine";
import { UserAvatar } from "@/components/user-avatar";

const WEDGES = new Map(FLAVOR_WHEEL.map((w) => [w.id, w]));

function wedgeLabel(wedgeId: string | null): string | null {
  return wedgeId ? WEDGES.get(wedgeId)?.label ?? null : null;
}

/**
 * The one Fraunces sentence: the month's most notable fact about the
 * drinker's PALATE. Never about how much or how often they poured — that
 * framing is the frequency reward the guardrails forbid.
 */
function monthSentence(data: DashboardData): string {
  const rising = wedgeLabel(data.risingWedgeId);
  if (!rising) {
    return `Your ${data.monthName} page is still blank — the first note writes it.`;
  }
  if (data.hadPrevMonth) {
    return `${rising} rose the most on your palate since ${data.prevMonthName}.`;
  }
  return `Your palate leaned ${rising} this month.`;
}

function StatTile({ value, label, sub }: { value: string; label: string; sub: string }) {
  return (
    <div className="card-flat min-w-0 flex-1 p-3">
      <div className="font-display text-[21px] font-medium leading-none text-accent">{value}</div>
      <div className="mt-1.5 text-[11.5px] leading-tight text-foreground/85">{label}</div>
      <div className="mt-1 text-[11px] leading-tight text-muted">{sub}</div>
    </div>
  );
}

/**
 * Home's upper half: the month in review. Under 3 lifetime pours it renders
 * the same skeleton in the same order — greyed, with empty tracks and a card
 * explaining what one logged dram unlocks — never hidden.
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
  const skeleton = data.totalPours < 3;
  const maxShare = data.topCategories[0]?.sharePct ?? 0;

  return (
    <section aria-label="Your month" className="flex flex-col gap-4">
      <div>
        <header className="flex items-center justify-between gap-3">
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
            {data.monthName.toUpperCase()}
          </span>
          <UserAvatar name={userName} image={userImage} size={32} />
        </header>
        <p className="mt-1.5 font-display text-[21px] font-medium leading-snug">
          {monthSentence(data)}
        </p>
      </div>

      <div className={`flex gap-2 ${skeleton ? "opacity-60" : ""}`}>
        {/* Breadth, not volume: this grows by paying closer attention to a
            dram, never by pouring another one. */}
        <StatTile
          value={String(data.descriptorsNamed)}
          label={`flavor${data.descriptorsNamed === 1 ? "" : "s"} named`}
          sub={`across ${data.bottlesNoted} bottle${data.bottlesNoted === 1 ? "" : "s"}`}
        />
        <StatTile
          value={String(data.newBottles)}
          label={`new bottle${data.newBottles === 1 ? "" : "s"}`}
          sub={`${data.shelfTotal} on the shelf`}
        />
        <StatTile
          value={data.agreement != null ? `${Math.round(data.agreement * 100)}%` : "—"}
          label="palate agreement"
          sub={data.agreement != null ? "with the label" : "needs tagged pours"}
        />
      </div>

      <div>
        <h3 className="section-label mb-2.5">What you reached for</h3>
        {data.topCategories.length > 0 ? (
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
                    style={{ backgroundColor: "#241d14" }}
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
        ) : (
          <ul className="flex flex-col gap-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="w-[104px] shrink-0 text-xs text-muted/50">—</span>
                <span className="h-2 min-w-0 flex-1 rounded-full" style={{ backgroundColor: "#241d14" }} />
                <span className="w-10 shrink-0" />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="section-label mb-2.5">Running low</h3>
        {data.runningLow.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {data.runningLow.map((row) => (
              <li
                key={row.userBottleId}
                className="flex items-stretch gap-[13px] rounded-2xl border px-3.5 py-3"
                style={{ borderColor: "#2e2519", background: "rgba(244,236,221,.03)" }}
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
        ) : (
          <p className="px-1 text-sm text-muted">
            {skeleton ? "Bottles under 30% will surface here." : "Nothing running low."}
          </p>
        )}
      </div>

      {skeleton && (
        <div className="card p-5">
          <h3 className="font-display text-lg font-semibold">One note fills this in</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Tag what you taste and this becomes your month: the flavors you named, how your
            palate reads against the label, and which bottles are running low.
          </p>
          <Link
            href="/scan"
            className="btn-primary mt-4 inline-flex min-h-11 items-center justify-center gap-2 px-5 py-3 text-sm"
          >
            <ScanLine size={18} strokeWidth={1.8} aria-hidden />
            Scan a bottle
          </Link>
        </div>
      )}
    </section>
  );
}
