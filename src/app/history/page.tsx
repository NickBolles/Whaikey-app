import Link from "next/link";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listPours, type PourListItem } from "@/lib/pours";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";

export const dynamic = "force-dynamic";

const wedgeColor = new Map(FLAVOR_WHEEL.map((w) => [w.id, w.color]));

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
    <li className="rounded-xl bg-surface border border-border-subtle p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link href={`/bottles/${pour.bottleId}`} className="font-semibold hover:text-accent">
            {pour.bottleName}
          </Link>
          <div className="text-xs text-muted mt-0.5">
            {[
              time,
              pour.servingStyle,
              pour.amountMl != null ? `${pour.amountMl} ml` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        {pour.rating != null && (
          <span className="text-accent font-semibold shrink-0">★ {pour.rating.toFixed(1)}</span>
        )}
      </div>

      {snippet && <p className="text-sm text-muted">{snippet}</p>}

      {shownTags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Flavor tags">
          {shownTags.map(([leafId, intensity]) => (
            <li
              key={leafId}
              className="flex items-center gap-1 rounded-full bg-surface-raised border border-border-subtle px-2.5 py-1 text-xs"
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: wedgeColor.get(wedgeForLeaf(leafId) ?? "") ?? "var(--muted)" }}
                aria-hidden
              />
              {leafLabel(leafId) ?? leafId}
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
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-4">
        <div className="text-5xl">📖</div>
        <p className="text-muted max-w-sm">Sign in to see your tasting journal.</p>
        <Link
          href="/sign-in"
          className="rounded-xl bg-accent text-background font-semibold px-6 py-3 hover:bg-accent-deep transition-colors"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const pours = await listPours(getDb(), user.id, { limit: 100 });

  if (pours.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60dvh] px-6 text-center gap-4">
        <div className="text-5xl">🥃</div>
        <div>
          <h1 className="text-xl font-bold">No pours yet</h1>
          <p className="text-muted mt-1 max-w-sm">
            Your tasting journal starts with the first glass.
          </p>
        </div>
        <Link
          href="/pour"
          className="rounded-xl bg-accent text-background font-semibold px-6 py-3 hover:bg-accent-deep transition-colors"
        >
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
          <h1 className="text-2xl font-bold">Tasting journal</h1>
          <p className="text-muted text-sm mt-1">
            {pours.length} pour{pours.length === 1 ? "" : "s"} logged
          </p>
        </div>
        <Link href="/pour" className="text-sm text-accent font-semibold hover:underline">
          Log a pour
        </Link>
      </header>

      {groups.map((group) => (
        <section key={group.day} aria-label={group.day}>
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            {group.day}
          </h2>
          <ul className="flex flex-col gap-2">
            {group.pours.map((pour) => (
              <PourRow key={pour.id} pour={pour} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
