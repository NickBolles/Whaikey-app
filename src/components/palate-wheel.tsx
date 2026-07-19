import { FlavorRadar } from "@/components/flavor-radar";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import { displayPalateWheel, topWedges } from "@/lib/palate";

export interface PalateWheelProps {
  /** The user's signed palate preference vector (wedge id -> signed weight). */
  vector: Record<string, number>;
  /** How many pours carried a usable flavor signal (0 => no palate yet). */
  sampleSize: number;
  /** Radar width/height in px (SVG scales responsively). */
  size?: number;
}

const WEDGE_LABELS: Record<string, string> = Object.fromEntries(
  FLAVOR_WHEEL.map((w) => [w.id, w.label]),
);

/**
 * The user's taste fingerprint: reuses FlavorRadar to paint their preferred
 * flavor wedges (non-negative, max-normalized via displayPalateWheel), with a
 * caption naming their top wedges. Pure/server-safe — safe to drop anywhere.
 * Falls back to an on-design empty state before any pours carry a signal.
 */
export function PalateWheel({ vector, sampleSize, size = 300 }: PalateWheelProps) {
  const display = displayPalateWheel(vector);
  const hasSignal = sampleSize > 0 && Object.values(display).some((v) => v > 0);

  if (!hasSignal) {
    return (
      <section aria-label="Your palate">
        <h2 className="section-label mb-3">Your palate</h2>
        <div className="card flex flex-col items-center gap-3 px-6 py-10 text-center">
          <div aria-hidden className="text-5xl drop-shadow-[0_0_24px_rgba(232,161,60,0.25)]">
            📖
          </div>
          <p className="font-display text-lg font-semibold">
            Your palate is still a blank page.
          </p>
          <p className="text-sm text-muted max-w-xs">
            Log a few pours and your flavor fingerprint appears here.
          </p>
        </div>
      </section>
    );
  }

  const top = topWedges(vector, 3);

  return (
    <section aria-label="Your palate">
      <h2 className="section-label mb-3">Your palate</h2>
      <div className="card flex flex-col items-center gap-4 p-4">
        <FlavorRadar profile={display} size={size} />
        {top.length > 0 && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-[11px] text-muted uppercase tracking-[0.14em]">You lean toward</p>
            <ul className="flex flex-wrap justify-center gap-2">
              {top.map((id) => (
                <li key={id} className="chip px-3 py-1 text-xs">
                  {WEDGE_LABELS[id] ?? id}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
