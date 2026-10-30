import Link from "next/link";
import { CalendarDays, ChevronRight, MapPin, Route, Users, Wine } from "lucide-react";
import type { ReactNode } from "react";
import type { Gatherings } from "@/lib/gather";
import { TRAIL } from "@/lib/challenges/term";

/**
 * "Get together" — outings, clubs, tasting nights and trails in one place,
 * on Home and at the top of Social (owner feedback 2026-10-26). An upcoming
 * outing leads as the module's one accent card; with none planned it offers
 * to plan one. Counts are of gatherings you belong to — never of pours.
 */
export function GatherModule({
  data,
  compact = false,
  showOuting = true,
}: {
  data: Gatherings;
  compact?: boolean;
  /** Home shows the next outing under "What's next" and passes false here. */
  showOuting?: boolean;
}) {
  const { nextOuting, clubCount, openNights } = data;
  return (
    <section aria-label="Get together" className="flex flex-col gap-2.5">
      {!compact && (
        <div className="flex items-baseline justify-between">
          <h2 className="section-label">Get together</h2>
          <Link href="/clubs" className="tap-target text-sm text-muted transition-colors hover:text-foreground">
            All →
          </Link>
        </div>
      )}

      {showOuting && <NextOutingCard data={data} />}

      <ul className="grid grid-cols-3 gap-2">
        <GatherTile href="/clubs" icon={<Users size={18} strokeWidth={1.8} aria-hidden />} label="Clubs" detail={clubCount > 0 ? `${clubCount} joined` : "Start one"} />
        <GatherTile
          href={openNights > 0 ? "/clubs#nights-heading" : "/flights/new"}
          icon={<Wine size={18} strokeWidth={1.8} aria-hidden />}
          label="Tasting night"
          detail={openNights > 0 ? `${openNights} open` : "Host blind"}
        />
        <GatherTile href={TRAIL.path} icon={<Route size={18} strokeWidth={1.8} aria-hidden />} label={TRAIL.many} detail="Explore new" />
      </ul>
      {!compact && showOuting && !nextOuting && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <CalendarDays size={14} strokeWidth={1.8} aria-hidden /> Guests can join outings and tasting nights by QR, no account needed.
        </p>
      )}
    </section>
  );
}

/** The soonest outing you're on, or an invitation to plan one. */
export function NextOutingCard({ data }: { data: Gatherings }) {
  const { nextOuting } = data;
  if (nextOuting) {
    return (
      <Link
        href={`/o/${nextOuting.joinCode}`}
        data-testid="gather-next-outing"
        className="card flex items-center gap-3 border-accent/50 p-3.5 transition-colors hover:bg-surface-raised"
      >
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <MapPin size={20} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-accent">
            {nextOuting.dayLabel} · Outing
          </span>
          <span className="block truncate font-display text-[17px] font-semibold leading-tight">{nextOuting.title}</span>
          <span className="block truncate text-xs text-muted">
            {outingDetail(nextOuting)}
          </span>
        </span>
        <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
      </Link>
    );
  }
  return (
      <Link
        href="/outings/new"
        className="card flex items-center gap-3 p-3.5 transition-colors hover:bg-surface-raised"
      >
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <MapPin size={20} strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-[16px] font-semibold leading-tight">Plan a distillery outing</span>
          <span className="block text-xs text-muted">Pick a day and a place. Guests join by QR.</span>
        </span>
        <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
      </Link>
      );
}

/** "Buffalo Trace · 5 going · 7 bottles on the list" — the plan at a glance. */
export function outingDetail(o: Gatherings["nextOuting"] & object): string {
  const parts: string[] = [];
  if (o.distilleryName) parts.push(o.distilleryName);
  if (o.goingCount != null) parts.push(`${o.goingCount} going`);
  if (o.bottleCount != null) {
    parts.push(o.bottleCount > 0 ? `${o.bottleCount} bottle${o.bottleCount === 1 ? "" : "s"} on the list` : "No bottles on the list yet");
  }
  return parts.length > 0 ? parts.join(" · ") : "Guests join by QR";
}

function GatherTile({ href, icon, label, detail }: { href: string; icon: ReactNode; label: string; detail: string }) {
  return (
    <li>
      <Link
        href={href}
        className="card-flat flex min-h-[72px] flex-col justify-between gap-1 p-2.5 transition-colors hover:bg-surface-raised"
      >
        <span className="text-accent">{icon}</span>
        <span>
          <span className="block truncate text-[13px] font-medium leading-tight">{label}</span>
          <span className="block truncate text-xs text-muted">{detail}</span>
        </span>
      </Link>
    </li>
  );
}
