"use client";

import { useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { Star } from "lucide-react";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";

/** Serialized pour crossing the server→client boundary (timestamp as ISO). */
export interface TimelinePour {
  id: string;
  bottleId: string;
  bottleName: string;
  rating: number | null;
  servingStyle: string | null;
  amountMl: number | null;
  createdAt: string;
  note: {
    nose: string | null;
    palate: string | null;
    finish: string | null;
    freeform: string | null;
    flavorTags: Record<string, number> | null;
  } | null;
}

/** Nudge a wedge hue toward the warm brass palette (kept in sync with FlavorWheelInput). */
function warmify(hex: string): string {
  const warm = [185, 141, 79]; // brass midpoint (#b98d4f)
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = rgb.map((c, i) => Math.round(c * 0.78 + warm[i] * 0.22));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const wedgeColor = new Map(FLAVOR_WHEEL.map((w) => [w.id, warmify(w.color)]));

function noteSnippet(note: TimelinePour["note"]): string | null {
  if (!note) return null;
  const text = note.nose ?? note.palate ?? note.finish ?? note.freeform;
  if (!text) return null;
  return text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text;
}

function dayKey(date: Date, now: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function PourRow({ pour }: { pour: TimelinePour }) {
  const snippet = noteSnippet(pour.note);
  const tags = pour.note?.flavorTags ? Object.entries(pour.note.flavorTags) : [];
  const shownTags = tags.slice(0, 4);
  const time = new Date(pour.createdAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <li className="card-flat p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link href={`/bottles/${pour.bottleId}`} className="font-medium hover:text-accent transition-colors">
            {pour.bottleName}
          </Link>
          <div className="text-xs text-muted mt-1">
            {[
              pour.servingStyle,
              pour.amountMl != null ? `${pour.amountMl} ml` : null,
              time,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        {pour.rating != null && (
          <span className="flex items-center gap-1.5 text-accent shrink-0">
            <Star size={14} fill="currentColor" aria-hidden />
            <span className="stat-number text-lg leading-none">{pour.rating.toFixed(1)}</span>
          </span>
        )}
      </div>

      {snippet && <p className="text-sm text-muted italic">{snippet}</p>}

      {shownTags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Flavor tags">
          {shownTags.map(([leafId, intensity]) => (
            <li key={leafId} className="chip flex items-center gap-1.5 px-2.5 py-1 text-xs">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: wedgeColor.get(wedgeForLeaf(leafId) ?? "") ?? "var(--muted)" }}
                aria-hidden
              />
              <span className="text-foreground/90">{leafLabel(leafId) ?? leafId}</span>
              <span className="text-accent">{"×".repeat(Math.min(intensity, 3))}</span>
            </li>
          ))}
          {tags.length > 4 && (
            <li className="rounded-full px-2 py-1 text-xs text-muted">+{tags.length - 4}</li>
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * Groups pours into day sections and formats times in the viewer's timezone.
 * Grouping is TZ-dependent (a late-night pour can land on a different calendar
 * day per zone), so it must run on the client — the server has no idea where
 * the viewer is. We render the flat, TZ-free row list on first paint (matching
 * SSR) and swap in day-grouped headers once mounted, avoiding a hydration
 * mismatch without a loading flash.
 */
const emptySubscribe = () => () => {};

/** False during SSR and the first client render, true once hydrated. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

export function HistoryTimeline({ pours }: { pours: TimelinePour[] }) {
  const mounted = useHydrated();

  const groups = useMemo(() => {
    const now = new Date();
    const out: Array<{ day: string; pours: TimelinePour[] }> = [];
    for (const pour of pours) {
      const day = dayKey(new Date(pour.createdAt), now);
      const last = out[out.length - 1];
      if (last && last.day === day) last.pours.push(pour);
      else out.push({ day, pours: [pour] });
    }
    return out;
  }, [pours]);

  if (!mounted) {
    // First paint: no day headers (their labels are timezone-dependent), just
    // the rows in order. Deterministic and identical on server and client.
    return (
      <ul className="flex flex-col gap-2.5">
        {pours.map((pour) => (
          <PourRow key={pour.id} pour={pour} />
        ))}
      </ul>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <section key={group.day} aria-label={group.day}>
          <h2 className="section-label mb-3">{group.day}</h2>
          <ul className="flex flex-col gap-2.5">
            {group.pours.map((pour) => (
              <PourRow key={pour.id} pour={pour} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
