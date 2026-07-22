import Link from "next/link";
import { getDb } from "@/db";
import { getSessionUser } from "@/lib/session";
import { listPours } from "@/lib/pours";
import { HistoryTimeline, type TimelinePour } from "./history-timeline";

export const dynamic = "force-dynamic";

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

  const timeline: TimelinePour[] = pours.map((pour) => ({
    id: pour.id,
    bottleId: pour.bottleId,
    bottleName: pour.bottleName,
    rating: pour.rating,
    servingStyle: pour.servingStyle,
    amountMl: pour.amountMl,
    createdAt: pour.createdAt.toISOString(),
    note: pour.note
      ? {
          nose: pour.note.nose,
          palate: pour.note.palate,
          finish: pour.note.finish,
          freeform: pour.note.freeform,
          flavorTags: pour.note.flavorTags,
        }
      : null,
  }));

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

      <HistoryTimeline pours={timeline} />
    </div>
  );
}
