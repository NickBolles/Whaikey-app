"use client";

import { useMemo, useState } from "react";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import {
  SERIF,
  arcPath,
  labelTransform,
  polar,
  pressableKeys,
  shortLabel,
  warmify,
} from "@/components/wheel-geometry";

export interface FlavorWheelInputProps {
  /** {leafId: intensity 1-3} */
  value: Record<string, number>;
  onChange: (value: Record<string, number>) => void;
}

const SIZE = 340;
const C = SIZE / 2;
const R_WEDGE_IN = 66;
const R_WEDGE_OUT = 106;
const R_WEDGE_OUT_SELECTED = 111; // selected wedge grows subtly outward
const R_LEAF_IN = 116;
const R_LEAF_OUT = 144; // grows +4 per intensity step, max 156
const WEDGE_LABEL_R = (R_WEDGE_IN + R_WEDGE_OUT) / 2;
const LEAF_LABEL_R = (R_LEAF_IN + R_LEAF_OUT) / 2;

/**
 * The Whaikey flavor wheel. Inner ring: the 8 core wedges. Tap a wedge and
 * its leaf descriptors fan out across the full outer ring (big targets).
 * Tap a leaf to cycle its intensity 0 -> 1 -> 2 -> 3 -> 0; intensity shows as
 * opacity, radial growth, and a numeric badge. Selected tags render as
 * removable chips below the wheel. Controlled: {value, onChange}.
 */
export function FlavorWheelInput({ value, onChange }: FlavorWheelInputProps) {
  const [selectedWedgeId, setSelectedWedgeId] = useState<string | null>(null);
  const selectedWedge = FLAVOR_WHEEL.find((w) => w.id === selectedWedgeId) ?? null;

  const wedgeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const wedge of FLAVOR_WHEEL) {
      counts.set(wedge.id, wedge.leaves.filter((l) => (value[l.id] ?? 0) > 0).length);
    }
    return counts;
  }, [value]);

  /** Selected tags in wheel order, for stable chips. */
  const chips = useMemo(() => {
    const out: Array<{ leafId: string; label: string; intensity: number; color: string }> = [];
    for (const wedge of FLAVOR_WHEEL) {
      for (const leaf of wedge.leaves) {
        const intensity = value[leaf.id] ?? 0;
        if (intensity > 0)
          out.push({ leafId: leaf.id, label: leaf.label, intensity, color: warmify(wedge.color) });
      }
    }
    return out;
  }, [value]);

  const cycleLeaf = (leafId: string) => {
    const next = ((value[leafId] ?? 0) + 1) % 4;
    const nextValue = { ...value };
    if (next === 0) delete nextValue[leafId];
    else nextValue[leafId] = next;
    onChange(nextValue);
  };

  const removeLeaf = (leafId: string) => {
    const nextValue = { ...value };
    delete nextValue[leafId];
    onChange(nextValue);
  };

  const toggleWedge = (wedgeId: string) => {
    setSelectedWedgeId((cur) => (cur === wedgeId ? null : wedgeId));
  };

  const wedgeSpan = 360 / FLAVOR_WHEEL.length;

  return (
    <div className="flex flex-col items-center gap-3">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full max-w-[360px] select-none touch-manipulation"
        role="application"
        aria-label="Flavor wheel"
      >
        {/* Inner ring: the 8 wedges */}
        {FLAVOR_WHEEL.map((wedge, i) => {
          const start = i * wedgeSpan;
          const end = start + wedgeSpan;
          const mid = start + wedgeSpan / 2;
          const isSelected = wedge.id === selectedWedgeId;
          const dimmed = selectedWedgeId !== null && !isSelected;
          const count = wedgeCounts.get(wedge.id) ?? 0;
          const color = warmify(wedge.color);
          const rOut = isSelected ? R_WEDGE_OUT_SELECTED : R_WEDGE_OUT;
          const badge = polar(C, rOut - 7, mid);
          return (
            <g
              key={wedge.id}
              role="button"
              tabIndex={0}
              aria-label={wedge.label}
              aria-pressed={isSelected}
              onClick={() => toggleWedge(wedge.id)}
              onKeyDown={pressableKeys(() => toggleWedge(wedge.id))}
              className="cursor-pointer focus:outline-none"
            >
              <path
                d={arcPath(C, R_WEDGE_IN, rOut, start, end)}
                fill={color}
                fillOpacity={isSelected ? 1 : dimmed ? 0.28 : 0.78}
                stroke={isSelected ? "var(--foreground)" : "var(--border)"}
                strokeOpacity={isSelected ? 0.7 : 1}
                strokeWidth={isSelected ? 1 : 0.75}
              />
              <text
                transform={labelTransform(C, WEDGE_LABEL_R, mid)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={isSelected ? 700 : 600}
                fill="#16110c"
                opacity={dimmed ? 0.45 : 0.92}
                pointerEvents="none"
              >
                {shortLabel(wedge.label)}
              </text>
              {count > 0 && (
                <g pointerEvents="none">
                  <circle cx={badge.x} cy={badge.y} r={7} fill="var(--background)" />
                  <text
                    x={badge.x}
                    y={badge.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={9}
                    fontWeight={700}
                    fill={color}
                  >
                    {count}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* Outer ring: leaves of the selected wedge, fanned across the full circle */}
        {selectedWedge &&
          selectedWedge.leaves.map((leaf, i) => {
            const span = 360 / selectedWedge.leaves.length;
            const start = i * span;
            const end = start + span;
            const mid = start + span / 2;
            const intensity = value[leaf.id] ?? 0;
            const rOut = R_LEAF_OUT + intensity * 4;
            const badge = polar(C, rOut - 9, mid);
            const color = warmify(selectedWedge.color);
            return (
              <g
                key={leaf.id}
                role="button"
                tabIndex={0}
                aria-label={intensity > 0 ? `${leaf.label}, intensity ${intensity}` : leaf.label}
                aria-pressed={intensity > 0}
                onClick={() => cycleLeaf(leaf.id)}
                onKeyDown={pressableKeys(() => cycleLeaf(leaf.id))}
                className="cursor-pointer focus:outline-none"
              >
                <path
                  d={arcPath(C, R_LEAF_IN, rOut, start, end, Math.min(1.2, span / 10))}
                  fill={color}
                  fillOpacity={intensity === 0 ? 0.26 : 0.42 + 0.19 * intensity}
                  stroke={intensity > 0 ? "var(--foreground)" : "var(--border)"}
                  strokeOpacity={intensity > 0 ? 0.55 : 1}
                  strokeWidth={intensity > 0 ? 1 : 0.75}
                />
                <text
                  transform={labelTransform(C, LEAF_LABEL_R, mid)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9}
                  fontWeight={intensity > 0 ? 700 : 500}
                  fill="var(--foreground)"
                  pointerEvents="none"
                >
                  {shortLabel(leaf.label)}
                </text>
                {intensity > 0 && (
                  <g pointerEvents="none">
                    <circle cx={badge.x} cy={badge.y} r={7} fill="var(--background)" />
                    <text
                      x={badge.x}
                      y={badge.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={9}
                      fontWeight={700}
                      fill={color}
                    >
                      {intensity}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

        {/* Center label — serif, like a label on aged glass */}
        <text
          x={C}
          y={C - 8}
          textAnchor="middle"
          fontSize={16}
          fontWeight={600}
          fill="var(--foreground)"
          style={{ fontFamily: SERIF }}
          pointerEvents="none"
        >
          {selectedWedge ? shortLabel(selectedWedge.label) : "Flavors"}
        </text>
        <text
          x={C}
          y={C + 11}
          textAnchor="middle"
          fontSize={9}
          fill="var(--muted)"
          pointerEvents="none"
        >
          {selectedWedge ? "tap a flavor to set intensity" : "tap a category"}
        </text>
        {chips.length > 0 && (
          <text
            x={C}
            y={C + 27}
            textAnchor="middle"
            fontSize={9}
            fontWeight={600}
            fill="var(--accent)"
            pointerEvents="none"
          >
            {chips.length} tagged
          </text>
        )}
      </svg>

      {chips.length > 0 && (
        <ul className="flex flex-wrap justify-center gap-2" aria-label="Selected flavors">
          {chips.map((chip) => (
            <li key={chip.leafId}>
              <button
                type="button"
                onClick={() => removeLeaf(chip.leafId)}
                aria-label={`Remove ${chip.label}`}
                className="chip flex items-center gap-1.5 px-3 py-1.5 text-xs hover:border-danger/60"
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: chip.color }}
                  aria-hidden
                />
                <span className="text-foreground/90">
                  {chip.label} <span className="text-accent">{"×".repeat(chip.intensity)}</span>
                </span>
                <span className="text-muted" aria-hidden>
                  ✕
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
