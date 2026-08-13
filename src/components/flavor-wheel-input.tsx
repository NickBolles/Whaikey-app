"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";
import { haptic } from "@/lib/native/haptics";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import {
  WHEEL_HOLD_MS,
  intensityForRadius,
  shouldActivateWheelGesture,
  shouldStartWheelGesture,
  wheelIndex,
  wheelPointFromPointer,
} from "@/components/wheel-gesture";
import {
  SERIF,
  arcPath,
  labelTransform,
  leafShade,
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
 * opacity, radial growth, and a numeric badge. On touch, hold a family, drag
 * out to a descriptor, then release: farther outward means more presence.
 * Selected tags render as removable chips below the wheel. Controlled: {value, onChange}.
 */
export function FlavorWheelInput({ value, onChange }: FlavorWheelInputProps) {
  const [selectedWedgeId, setSelectedWedgeId] = useState<string | null>(null);
  const [gestureLeafId, setGestureLeafId] = useState<string | null>(null);
  const gestureLeafIdRef = useRef<string | null>(null);
  const [gestureIntensity, setGestureIntensity] = useState<1 | 2 | 3>(1);
  const gestureIntensityRef = useRef<1 | 2 | 3>(1);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeGesture = useRef(false);
  const holdElapsed = useRef(false);
  const activationStart = useRef<{ clientX: number; clientY: number } | null>(null);
  const activePointerId = useRef<number | null>(null);
  const gestureWedgeId = useRef<string | null>(null);
  const hapticCategoryId = useRef<string | null>(null);
  const hapticIntensity = useRef<1 | 2 | 3 | null>(null);
  const suppressClick = useRef(false);
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
      const family = warmify(wedge.color);
      wedge.leaves.forEach((leaf, i) => {
        const intensity = value[leaf.id] ?? 0;
        if (intensity > 0)
          out.push({
            leafId: leaf.id,
            label: leaf.label,
            intensity,
            color: leafShade(family, i, wedge.leaves.length),
          });
      });
    }
    return out;
  }, [value]);

  const cycleLeaf = (leafId: string) => {
    const next = ((value[leafId] ?? 0) + 1) % 4;
    const nextValue = { ...value };
    if (next === 0) delete nextValue[leafId];
    else {
      nextValue[leafId] = next;
      haptic(({ 1: "intensity-1", 2: "intensity-2", 3: "intensity-3" } as const)[next]);
    }
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

  const clearGesture = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    activeGesture.current = false;
    holdElapsed.current = false;
    activationStart.current = null;
    activePointerId.current = null;
    gestureWedgeId.current = null;
    hapticCategoryId.current = null;
    hapticIntensity.current = null;
    gestureLeafIdRef.current = null;
    setGestureLeafId(null);
  };

  const updateGestureLeaf = (event: PointerEvent<SVGSVGElement>, wedgeId: string) => {
    const wedge = FLAVOR_WHEEL.find((item) => item.id === wedgeId);
    if (!wedge) return;
    const point = wheelPointFromPointer(event, SIZE);
    if (point.radius < R_LEAF_IN) {
      gestureLeafIdRef.current = null;
      setGestureLeafId(null);
      return;
    }
    const leaf = wedge.leaves[wheelIndex(point.angle, wedge.leaves.length)];
    const intensity = intensityForRadius(point.radius);
    if (intensity > (hapticIntensity.current ?? 0)) {
      haptic(({ 1: "intensity-1", 2: "intensity-2", 3: "intensity-3" } as const)[intensity]);
    }
    hapticIntensity.current = intensity;
    gestureLeafIdRef.current = leaf.id;
    gestureIntensityRef.current = intensity;
    setGestureLeafId(leaf.id);
    setGestureIntensity(intensity);
  };

  const updateGestureAt = (event: PointerEvent<SVGSVGElement>) => {
    const point = wheelPointFromPointer(event, SIZE);
    if (point.radius < R_LEAF_IN) {
      const wedge = FLAVOR_WHEEL[wheelIndex(point.angle, FLAVOR_WHEEL.length)];
      if (hapticCategoryId.current !== wedge.id) haptic("category");
      hapticCategoryId.current = wedge.id;
      gestureWedgeId.current = wedge.id;
      setSelectedWedgeId(wedge.id);
      gestureLeafIdRef.current = null;
      setGestureLeafId(null);
      return;
    }
    const wedgeId = gestureWedgeId.current;
    if (wedgeId) updateGestureLeaf(event, wedgeId);
  };

  const startGesture = (event: PointerEvent<SVGSVGElement>) => {
    if (!shouldStartWheelGesture(event) || activePointerId.current !== null) return;
    const point = wheelPointFromPointer(event, SIZE);
    const wedge = FLAVOR_WHEEL[wheelIndex(point.angle, FLAVOR_WHEEL.length)];
    activePointerId.current = event.pointerId;
    activationStart.current = { clientX: event.clientX, clientY: event.clientY };
    hapticCategoryId.current = wedge.id;
    hapticIntensity.current = null;
    gestureWedgeId.current = wedge.id;
    holdTimer.current = setTimeout(() => {
      holdElapsed.current = true;
    }, WHEEL_HOLD_MS);
  };

  const moveGesture = (event: PointerEvent<SVGSVGElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    if (!activeGesture.current) {
      const start = activationStart.current;
      if (!holdElapsed.current || !start || !shouldActivateWheelGesture(start, event)) return;
      activeGesture.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      haptic("lock");
    }
    updateGestureAt(event);
  };

  const commitGesture = (event: PointerEvent<SVGSVGElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    if (activeGesture.current) updateGestureAt(event);
    const leafId = gestureLeafIdRef.current;
    if (activeGesture.current && leafId) {
      onChange({ ...value, [leafId]: gestureIntensityRef.current });
      haptic("success");
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 400);
    }
    clearGesture();
  };

  const handleWedgeClick = (wedgeId: string) => {
    if (suppressClick.current) return;
    toggleWedge(wedgeId);
  };

  const handleLeafClick = (leafId: string) => {
    if (suppressClick.current) return;
    cycleLeaf(leafId);
  };

  const wedgeSpan = 360 / FLAVOR_WHEEL.length;

  return (
    <div className="flex flex-col items-center gap-3">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full max-w-[360px] select-none touch-pan-y"
        role="application"
        aria-label="Flavor wheel"
        onPointerDown={startGesture}
        onPointerMove={moveGesture}
        onPointerUp={commitGesture}
        onPointerCancel={(event) => {
          if (activePointerId.current === event.pointerId) clearGesture();
        }}
        onPointerLeave={(event) => {
          if (activePointerId.current === event.pointerId) clearGesture();
        }}
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
              onClick={() => handleWedgeClick(wedge.id)}
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
            const isGestureLeaf = leaf.id === gestureLeafId;
            const displayedIntensity = isGestureLeaf ? gestureIntensity : intensity;
            const rOut = R_LEAF_OUT + displayedIntensity * 4;
            const badge = polar(C, rOut - 9, mid);
            // Graded family shade so each subsection is its own color band.
            const color = leafShade(warmify(selectedWedge.color), i, selectedWedge.leaves.length);
            return (
              <g
                key={leaf.id}
                role="button"
                tabIndex={0}
                aria-label={displayedIntensity > 0 ? `${leaf.label}, intensity ${displayedIntensity}` : leaf.label}
                aria-pressed={displayedIntensity > 0}
                onClick={() => handleLeafClick(leaf.id)}
                onKeyDown={pressableKeys(() => cycleLeaf(leaf.id))}
                className="cursor-pointer focus:outline-none"
              >
                <path
                  d={arcPath(C, R_LEAF_IN, rOut, start, end, Math.min(1.2, span / 10))}
                  fill={color}
                  fillOpacity={displayedIntensity === 0 ? 0.26 : 0.42 + 0.19 * displayedIntensity}
                  stroke={displayedIntensity > 0 ? "var(--foreground)" : "var(--border)"}
                  strokeOpacity={displayedIntensity > 0 ? 0.55 : 1}
                  strokeWidth={displayedIntensity > 0 ? 1 : 0.75}
                />
                <text
                  transform={labelTransform(C, LEAF_LABEL_R, mid)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9}
                  fontWeight={displayedIntensity > 0 ? 700 : 500}
                  fill="var(--foreground)"
                  pointerEvents="none"
                >
                  {shortLabel(leaf.label)}
                </text>
                {displayedIntensity > 0 && (
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
                      {displayedIntensity}
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

      {selectedWedge && (
        <p className="max-w-[32ch] text-center text-xs leading-relaxed text-muted">
          Hold a family, sweep to a flavor, then release to save it. Drag farther out for more presence.
        </p>
      )}

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
