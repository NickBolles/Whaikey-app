import Link from "next/link";
import { Star } from "lucide-react";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listPours, type PourListItem } from "@/lib/pours";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";

export const dynamic = "force-dynamic";

/** Nudge a wedge hue toward the warm brass palette (kept in sync with FlavorWheelInput). */
function warmify(hex: string): string {
  const warm = [185, 141, 79]; // brass midpoint (#b98d4f)
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = rgb.map((c, i) => Math.round(c * 0.78 + warm[i] * 0.22));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const wedgeColor = new Map(FLAVOR_WHEEL.map((w) => [w.id, warmify(w.color)]));

function noteSnippet(note: PourListItem["note"]): string | null {
  if (!note) return null;
  const text = note.nose ?? note.palate ?? note.finish ?? note.freeform;
  if (!text) return null;
  return text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text;
}

function dayKey(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

function PourRow({ pour }: { pour: PourListItem }) {
  const snippet = noteSnippet(pour.note);
  const tags = pour.note?.flavorTags ? Object.entries(pour.note.flavorTags) : [];
  const shownTags = tags.slice(0, 4);
  const time = pour.createdAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

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

export default async function HistoryPage() {
  const user = await getSessionUser();
  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-5">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          📖
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">Your journal awaits</h1>
          <p className="text-muted mt-2 max-w-sm">Sign in to see your tasting journal.</p>
        </div>
        <Link href="/sign-in" className="btn-primary px-8 py-3">
          Sign in
        </Link>
      </div>
    );
  }

  const pours = await listPours(getDb(), user.id, { limit: 100 });

  if (pours.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-5">
        <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
          🥃
        </div>
        <div>
          <h1 className="font-display text-2xl font-semibold">No pours yet</h1>
          <p className="text-muted mt-2 max-w-sm">
            Your tasting journal starts with the first glass.
          </p>
        </div>
        <Link href="/pour" className="btn-primary px-8 py-3">
          Log your first pour
        </Link>
      </div>
    );
  }

  const groups: Array<{ day: string; pours: PourListItem[] }> = [];
  for (const pour of pours) {
    const day = dayKey(pour.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.pours.push(pour);
    else groups.push({ day, pours: [pour] });
  }

  return (
    <div className="px-4 pt-8 pb-24 flex flex-col gap-6 max-w-lg mx-auto">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-[2rem] leading-tight font-semibold">Tasting journal</h1>
          <p className="text-muted text-sm mt-1">
            {pours.length} pour{pours.length === 1 ? "" : "s"} logged
          </p>
        </div>
        <Link
          href="/pour"
          className="text-sm text-accent font-medium hover:brightness-110 transition-[filter] pb-0.5"
        >
          Log a pour
        </Link>
      </header>

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
    </div>
  );
}
