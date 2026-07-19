"use client";

import { useState } from "react";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import { WEDGE_NOTES } from "@/lib/education";
import {
  SERIF,
  arcPath,
  labelTransform,
  pressableKeys,
  shortLabel,
  warmify,
} from "@/components/wheel-geometry";

const SIZE = 340;
const C = SIZE / 2;
const R_IN = 58;
const R_OUT = 138;
const R_OUT_SELECTED = 144; // selected wedge grows subtly outward
const LABEL_R = (R_IN + R_OUT) / 2;

/**
 * Read-only educational flavor wheel for Whiskey School. One ring, the 8
 * core families; tap a wedge to read where the family comes from, what it
 * tastes like, its leaf descriptors, and where to spot it. Same taxonomy
 * and geometry as the note-capture wheel, different job: learning, not
 * logging.
 */
export function FlavorWheelExplorer() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = FLAVOR_WHEEL.find((w) => w.id === selectedId) ?? null;
  const note = selected ? WEDGE_NOTES[selected.id] : null;
  const span = 360 / FLAVOR_WHEEL.length;

  return (
    <div className="flex flex-col gap-4">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full max-w-[360px] self-center select-none touch-manipulation"
        role="application"
        aria-label="Flavor wheel explorer"
      >
        {FLAVOR_WHEEL.map((wedge, i) => {
          const start = i * span;
          const end = start + span;
          const mid = start + span / 2;
          const isSelected = wedge.id === selectedId;
          const dimmed = selectedId !== null && !isSelected;
          const color = warmify(wedge.color);
          const rOut = isSelected ? R_OUT_SELECTED : R_OUT;
          return (
            <g
              key={wedge.id}
              role="button"
              tabIndex={0}
              aria-label={wedge.label}
              aria-pressed={isSelected}
              onClick={() => setSelectedId((cur) => (cur === wedge.id ? null : wedge.id))}
              onKeyDown={pressableKeys(() =>
                setSelectedId((cur) => (cur === wedge.id ? null : wedge.id)),
              )}
              className="cursor-pointer focus:outline-none"
            >
              <path
                d={arcPath(C, R_IN, rOut, start, end)}
                fill={color}
                fillOpacity={isSelected ? 1 : dimmed ? 0.28 : 0.78}
                stroke={isSelected ? "var(--foreground)" : "var(--border)"}
                strokeOpacity={isSelected ? 0.7 : 1}
                strokeWidth={isSelected ? 1 : 0.75}
              />
              <text
                transform={labelTransform(C, LABEL_R, mid)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={12}
                fontWeight={isSelected ? 700 : 600}
                fill="#16110c"
                opacity={dimmed ? 0.45 : 0.92}
                pointerEvents="none"
              >
                {shortLabel(wedge.label)}
              </text>
            </g>
          );
        })}

        <text
          x={C}
          y={C - 6}
          textAnchor="middle"
          fontSize={15}
          fontWeight={600}
          fill="var(--foreground)"
          style={{ fontFamily: SERIF }}
          pointerEvents="none"
        >
          {selected ? shortLabel(selected.label) : "Explore"}
        </text>
        <text x={C} y={C + 12} textAnchor="middle" fontSize={9} fill="var(--muted)" pointerEvents="none">
          {selected ? `${selected.leaves.length} flavors inside` : "tap a family"}
        </text>
      </svg>

      {selected && note ? (
        <div className="card p-5 flex flex-col gap-4" aria-live="polite">
          <div className="flex items-center gap-2.5">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ backgroundColor: warmify(selected.color) }}
              aria-hidden
            />
            <h2 className="font-display text-xl font-semibold">{selected.label}</h2>
          </div>
          <p className="text-sm leading-relaxed text-foreground/90">{note.blurb}</p>
          <div>
            <h3 className="section-label mb-2">Where it comes from</h3>
            <p className="text-sm leading-relaxed text-muted">{note.source}</p>
          </div>
          <div>
            <h3 className="section-label mb-2">Spot it in</h3>
            <p className="text-sm leading-relaxed text-muted">{note.spotIt}</p>
          </div>
          <div>
            <h3 className="section-label mb-2">The flavors</h3>
            <ul className="flex flex-wrap gap-2">
              {selected.leaves.map((leaf) => (
                <li key={leaf.id} className="chip px-3 py-1.5 text-xs text-foreground/90">
                  {leaf.label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className="text-center text-sm text-muted">
          Tap a family on the wheel to see where its flavors come from and how to spot them.
        </p>
      )}
    </div>
  );
}
