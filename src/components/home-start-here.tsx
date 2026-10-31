import Link from "next/link";
import { ChevronRight, NotebookPen, ScanLine, Users, MapPin } from "lucide-react";
import type { ReactNode } from "react";

export interface StartAction {
  key: "log" | "scan" | "plan" | "club";
  href: string;
  title: string;
  detail: string;
}

/**
 * Home's zero state (no tastings this month): at most three useful next
 * steps, exactly one primary. Plain copy only — no blank-page metaphors
 * (owner feedback 2026-10-29). Never a nudge to pour more: the log action
 * is about writing a note on a bottle, and it is offered once.
 */
export function pickStartActions({
  bottleCount,
  hasTastedEver,
  hasNextOuting,
}: {
  bottleCount: number;
  hasTastedEver: boolean;
  hasNextOuting: boolean;
}): StartAction[] {
  const scan: StartAction = {
    key: "scan",
    href: "/scan",
    title: "Add bottles you own",
    detail: bottleCount > 0 ? `Scan a label. ${bottleCount} on your shelf so far.` : "Scan a label or search the catalog.",
  };
  const log: StartAction = {
    key: "log",
    href: "/pour",
    title: hasTastedEver ? "Log a tasting" : "Log your first tasting",
    detail: "Rate a bottle and tag a few flavors. Your month fills in from there.",
  };
  const plan: StartAction = {
    key: "plan",
    href: "/outings/new",
    title: "Plan a get-together",
    detail: "An outing or a tasting night. Guests join by QR.",
  };
  const club: StartAction = {
    key: "club",
    href: "/clubs",
    title: "Join a club or trail",
    detail: "Taste along with friends.",
  };
  // Nothing on the shelf: adding bottles comes first.
  const first = bottleCount > 0 ? [log, scan] : [scan, log];
  return [...first, hasNextOuting ? club : plan].slice(0, 3);
}

const ICONS: Record<StartAction["key"], ReactNode> = {
  log: <NotebookPen size={18} strokeWidth={1.8} aria-hidden />,
  scan: <ScanLine size={18} strokeWidth={1.8} aria-hidden />,
  plan: <MapPin size={18} strokeWidth={1.8} aria-hidden />,
  club: <Users size={18} strokeWidth={1.8} aria-hidden />,
};

export function HomeStartHere({ actions }: { actions: StartAction[] }) {
  const [primary, ...rest] = actions;
  if (!primary) return null;
  return (
    <section aria-label="Start here" className="flex flex-col gap-2.5">
      <h2 className="section-label">Start here</h2>
      <Link
        href={primary.href}
        data-testid="start-primary"
        className="card flex items-center gap-3 border-accent/50 p-4 transition-colors hover:bg-surface-raised"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-background">
          {ICONS[primary.key]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-[17px] font-semibold leading-tight">{primary.title}</span>
          <span className="block text-xs text-muted">{primary.detail}</span>
        </span>
        <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
      </Link>
      {rest.map((a) => (
        <Link
          key={a.key}
          href={a.href}
          className="card-flat flex min-h-11 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-raised"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            {ICONS[a.key]}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{a.title}</span>
            <span className="block truncate text-xs text-muted">{a.detail}</span>
          </span>
          <ChevronRight size={18} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
        </Link>
      ))}
    </section>
  );
}
