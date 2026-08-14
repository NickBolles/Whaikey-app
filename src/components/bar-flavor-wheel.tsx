"use client";

import { useRef, type MouseEvent, type ReactNode, type PointerEvent } from "react";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import { haptic } from "@/lib/native/haptics";
import { WHEEL_HOLD_MS, shouldActivateWheelGesture, shouldStartWheelGesture, wheelIndex, wheelPointFromPointer } from "@/components/wheel-gesture";
import { arcPath, bandLabelTransform, inkOn, labelTransform, leafShade, polar, pressableKeys, shortLabel, warmify } from "@/components/wheel-geometry";

export type FlavorSelection = {
  id: string;
  label: string;
  leafIds: string[];
};

/** How one descriptor reads once your notes are set against the label's. */
export type CalibrationMark = "shared" | "blind" | "signature";

export interface BarFlavorWheelProps {
  wedgeHeat: Record<string, number>;
  leafHeat: Record<string, number>;
  caption: string;
  subCaption?: string;
  selectedIds: string[];
  onToggle: (selection: FlavorSelection) => void;
  /**
   * Compare mode. The fill keeps carrying one quantity (the label's claim) and
   * agreement rides in a second channel, so the heat map stays readable as a
   * heat map. Each bucket gets a distinct shape as well as a colour, which
   * keeps the encoding alive in greyscale and for colour-blind readers.
   */
  marks?: Record<string, CalibrationMark>;
}

const SIZE = 340;
const C = SIZE / 2;
const INNER = [48, 79] as const;
const MIDDLE = [83, 112] as const;
const OUTER = [116, 162] as const;
/** Inside the descriptor band's outer third, clear of the labels at its centre. */
const MARK_RADIUS = 154;

const MARK_COLOR: Record<CalibrationMark, string> = {
  shared: "var(--taste-shared)",
  blind: "var(--taste-blind)",
  signature: "var(--taste-signature)",
};

/** The mark is a shape and a colour; this is the same fact for everyone else. */
const MARK_NOTE: Record<CalibrationMark, string> = {
  shared: "shared with the label",
  blind: "blind spot",
  signature: "yours alone",
};

const GROUPS: Record<string, Array<{ id: string; label: string; leaves: string[] }>> = {
  fruity: [
    { id: "orchard", label: "Orchard", leaves: ["green-apple", "pear"] },
    { id: "citrus", label: "Citrus", leaves: ["citrus", "orange-peel"] },
    { id: "dark-fruit", label: "Dark fruit", leaves: ["cherry", "dark-fruit", "raisin"] },
    { id: "tropical", label: "Tropical", leaves: ["banana", "tropical"] },
  ],
  floral: [
    { id: "flowers", label: "Flowers", leaves: ["heather", "rose", "lavender"] },
    { id: "botanical", label: "Botanical", leaves: ["grassy", "herbal", "mint"] },
  ],
  grain: [
    { id: "malted", label: "Malted", leaves: ["cereal", "malt", "biscuit"] },
    { id: "bakery", label: "Bakery", leaves: ["fresh-bread", "corn", "rye-spice"] },
  ],
  sweet: [
    { id: "confection", label: "Confection", leaves: ["vanilla", "caramel", "toffee", "butterscotch"] },
    { id: "syrupy", label: "Syrupy", leaves: ["honey", "maple", "brown-sugar", "chocolate"] },
  ],
  woody: [
    { id: "oak", label: "Oak", leaves: ["oak", "char", "cedar"] },
    { id: "earthy", label: "Earthy", leaves: ["tobacco", "leather", "nutty", "coffee"] },
  ],
  spicy: [
    { id: "baking-spice", label: "Baking spice", leaves: ["cinnamon", "clove", "nutmeg", "ginger"] },
    { id: "peppery", label: "Peppery", leaves: ["black-pepper", "anise", "chili"] },
  ],
  peaty: [
    { id: "smoke", label: "Smoke", leaves: ["campfire", "peat", "ash", "tar", "bbq"] },
    { id: "coastal", label: "Coastal", leaves: ["medicinal", "brine"] },
  ],
  feinty: [
    { id: "funk", label: "Funk", leaves: ["sulfur", "meaty", "waxy", "musty", "funky"] },
  ],
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function heatForLeaves(leafIds: string[], heat: Record<string, number>): number {
  return Math.max(0, ...leafIds.map((id) => heat[id] ?? 0));
}

type SelectionState = "none" | "mixed" | "all";

function selectionState(selection: FlavorSelection, selectedIds: string[]): SelectionState {
  const selectedCount = selection.leafIds.filter((id) => selectedIds.includes(id)).length;
  if (selectedCount === 0) return "none";
  return selectedCount === selection.leafIds.length ? "all" : "mixed";
}

function selected(selection: FlavorSelection, selectedIds: string[]): boolean {
  return selectionState(selection, selectedIds) !== "none";
}

/**
 * Interactive three-ring bar wheel. Rings are family → flavor group → descriptor;
 * every segment sends canonical leaf ids back to the Bar filter, so personal and
 * published modes always use the same taxonomy.
 */
export function BarFlavorWheel({ wedgeHeat, leafHeat, caption, subCaption, selectedIds, onToggle, marks }: BarFlavorWheelProps) {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureActive = useRef(false);
  const holdElapsed = useRef(false);
  const activationStart = useRef<{ clientX: number; clientY: number } | null>(null);
  const activePointerId = useRef<number | null>(null);
  const gestureLeafId = useRef<string | null>(null);
  const gestureCategoryId = useRef<string | null>(null);
  const suppressClick = useRef(false);
  const wedgeSpan = 360 / FLAVOR_WHEEL.length;
  const segments: ReactNode[] = [];
  const labels: ReactNode[] = [];
  const markNodes: ReactNode[] = [];

  FLAVOR_WHEEL.forEach((wedge, wedgeIndex) => {
    const start = wedgeIndex * wedgeSpan;
    const color = warmify(wedge.color);
    const family: FlavorSelection = { id: wedge.id, label: wedge.label, leafIds: wedge.leaves.map((leaf) => leaf.id) };
    const familyHeat = clamp01(wedgeHeat[wedge.id] ?? 0);
    const familyOpacity = 0.16 + familyHeat * 0.72;
    const familyActive = selected(family, selectedIds);
    const familyMid = start + wedgeSpan / 2;
    segments.push(
      <WheelSegment key={`family-${wedge.id}`} selection={family} active={familyActive} pressed={selectionState(family, selectedIds)} fill={color} opacity={familyOpacity} d={arcPath(C, INNER[0], INNER[1], start, start + wedgeSpan)} onToggle={onToggle} />,
    );
    labels.push(
      <text key={`family-label-${wedge.id}`} transform={labelTransform(C, (INNER[0] + INNER[1]) / 2, familyMid)} textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill={inkOn(color, familyOpacity)} pointerEvents="none">
        {shortLabel(wedge.label)}
      </text>,
    );

    const groups = GROUPS[wedge.id] ?? [];
    const orderedLeaves = groups
      .flatMap((group) => group.leaves)
      .map((leafId) => wedge.leaves.find((leaf) => leaf.id === leafId))
      .filter((leaf): leaf is (typeof wedge.leaves)[number] => leaf !== undefined);
    const leafCount = orderedLeaves.length || wedge.leaves.length;
    let groupStart = start;
    groups.forEach((group) => {
      // The group boundary must land on descriptor boundaries. Groups with more
      // descriptors occupy proportionally more of the middle ring.
      const groupSpan = wedgeSpan * (group.leaves.length / leafCount);
      const groupMid = groupStart + groupSpan / 2;
      const groupSelection: FlavorSelection = { id: `${wedge.id}.${group.id}`, label: group.label, leafIds: group.leaves };
      const groupHeat = heatForLeaves(group.leaves, leafHeat);
      const groupOpacity = 0.14 + Math.max(groupHeat, familyHeat * 0.45) * 0.72;
      const groupActive = selected(groupSelection, selectedIds);
      segments.push(
        <WheelSegment key={`group-${groupSelection.id}`} selection={groupSelection} active={groupActive} pressed={selectionState(groupSelection, selectedIds)} fill={color} opacity={groupOpacity} d={arcPath(C, MIDDLE[0], MIDDLE[1], groupStart, groupStart + groupSpan)} onToggle={onToggle} />,
      );
      const groupText = bandLabelTransform(C, MIDDLE[0], MIDDLE[1], groupMid, group.label, 7);
      labels.push(
        <text key={`group-label-${groupSelection.id}`} transform={groupText.transform} textAnchor={groupText.anchor} textLength={groupText.textLength} lengthAdjust={groupText.textLength ? "spacingAndGlyphs" : undefined} dominantBaseline="central" fontSize={7} fontWeight={700} fill={inkOn(color, groupOpacity)} pointerEvents="none">
          {group.label}
        </text>,
      );
      groupStart += groupSpan;
    });

    const leaves = orderedLeaves.length === wedge.leaves.length ? orderedLeaves : wedge.leaves;
    const leafSpan = wedgeSpan / leaves.length;
    leaves.forEach((leaf, leafIndex) => {
      const leafStart = start + leafIndex * leafSpan;
      const leafMid = leafStart + leafSpan / 2;
      const leafSelection: FlavorSelection = { id: leaf.id, label: leaf.label, leafIds: [leaf.id] };
      const descriptorHeat = clamp01(leafHeat[leaf.id] ?? 0);
      const shade = leafShade(color, leafIndex, leaves.length);
      const opacity = 0.12 + descriptorHeat * 0.8;
      segments.push(
        <WheelSegment key={`leaf-${leaf.id}`} selection={leafSelection} active={selected(leafSelection, selectedIds)} pressed={selectionState(leafSelection, selectedIds)} fill={shade} opacity={opacity} d={arcPath(C, OUTER[0], OUTER[1], leafStart, leafStart + leafSpan, Math.min(0.75, leafSpan / 8))} onToggle={onToggle} note={marks?.[leaf.id] ? MARK_NOTE[marks[leaf.id]] : undefined} />,
      );
      const mark = marks?.[leaf.id];
      if (mark) {
        const { x, y } = polar(C, MARK_RADIUS, leafMid);
        const color = MARK_COLOR[mark];
        markNodes.push(
          mark === "signature" ? (
            // A diamond, not a dot: shape carries the bucket too, so the wheel
            // still reads without colour.
            <path
              key={`mark-${leaf.id}`}
              d={`M${x} ${y - 3.4}L${x + 3.4} ${y}L${x} ${y + 3.4}L${x - 3.4} ${y}Z`}
              fill={color}
              stroke="var(--background)"
              strokeWidth={0.9}
            />
          ) : (
            <circle
              key={`mark-${leaf.id}`}
              cx={x}
              cy={y}
              r={mark === "shared" ? 3 : 2.7}
              fill={mark === "shared" ? color : "var(--background)"}
              stroke={mark === "shared" ? "var(--background)" : color}
              strokeWidth={mark === "shared" ? 0.9 : 1.5}
            />
          ),
        );
      }

      if (descriptorHeat >= 0.5 || selected(leafSelection, selectedIds)) {
        const leafText = bandLabelTransform(C, OUTER[0], OUTER[1], leafMid, shortLabel(leaf.label), 7);
        labels.push(
          <text key={`leaf-label-${leaf.id}`} transform={leafText.transform} textAnchor={leafText.anchor} textLength={leafText.textLength} lengthAdjust={leafText.textLength ? "spacingAndGlyphs" : undefined} dominantBaseline="central" fontSize={7} fontWeight={700} fill={inkOn(shade, opacity)} pointerEvents="none">
            {shortLabel(leaf.label)}
          </text>,
        );
      }
    });
  });

  const descriptorSelections = FLAVOR_WHEEL.flatMap((wedge) => wedge.leaves)
    .filter((leaf) => (leafHeat[leaf.id] ?? 0) > 0 || selectedIds.includes(leaf.id))
    .map((leaf) => ({ id: leaf.id, label: leaf.label, leafIds: [leaf.id] }));

  const clearGesture = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    gestureActive.current = false;
    holdElapsed.current = false;
    activationStart.current = null;
    activePointerId.current = null;
    gestureLeafId.current = null;
    gestureCategoryId.current = null;
  };

  const updateGesture = (event: PointerEvent<SVGSVGElement>) => {
    const point = wheelPointFromPointer(event, SIZE);
    const wedgeIndex = wheelIndex(point.angle, FLAVOR_WHEEL.length);
    const wedge = FLAVOR_WHEEL[wedgeIndex];
    if (gestureCategoryId.current !== wedge.id) haptic("category");
    gestureCategoryId.current = wedge.id;
    if (point.radius < OUTER[0]) {
      gestureLeafId.current = null;
      return;
    }
    const localAngle = (point.angle - wedgeIndex * wedgeSpan + 360) % 360;
    const leaf = wedge.leaves[wheelIndex(localAngle, wedge.leaves.length)];
    gestureLeafId.current = leaf.id;
  };

  const startGesture = (event: PointerEvent<SVGSVGElement>) => {
    if (!shouldStartWheelGesture(event) || activePointerId.current !== null) return;
    activePointerId.current = event.pointerId;
    activationStart.current = { clientX: event.clientX, clientY: event.clientY };
    gestureCategoryId.current = FLAVOR_WHEEL[wheelIndex(wheelPointFromPointer(event, SIZE).angle, FLAVOR_WHEEL.length)].id;
    holdTimer.current = setTimeout(() => {
      holdElapsed.current = true;
    }, WHEEL_HOLD_MS);
  };

  const moveGesture = (event: PointerEvent<SVGSVGElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    if (!gestureActive.current) {
      const start = activationStart.current;
      if (!holdElapsed.current || !start || !shouldActivateWheelGesture(start, event)) return;
      gestureActive.current = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      haptic("lock");
    }
    updateGesture(event);
  };

  const commitGesture = (event: PointerEvent<SVGSVGElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    if (gestureActive.current) updateGesture(event);
    const leafId = gestureLeafId.current;
    if (gestureActive.current && leafId) {
      const leaf = FLAVOR_WHEEL.flatMap((wedge) => wedge.leaves).find((item) => item.id === leafId);
      if (leaf) onToggle({ id: leaf.id, label: leaf.label, leafIds: [leaf.id] });
      haptic("success");
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 400);
    }
    clearGesture();
  };

  const interceptGestureClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!suppressClick.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="flex w-full flex-col items-center gap-3" data-testid="bar-flavor-wheel">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full max-w-[360px] select-none touch-pan-y"
        role="group"
        aria-label={`${caption} flavor wheel`}
        onPointerDown={startGesture}
        onPointerMove={moveGesture}
        onPointerUp={commitGesture}
        onPointerCancel={(event) => {
          if (activePointerId.current === event.pointerId) clearGesture();
        }}
        onPointerLeave={(event) => {
          if (activePointerId.current === event.pointerId) clearGesture();
        }}
        onClickCapture={interceptGestureClick}
      >
        {segments}
        <g pointerEvents="none" data-testid="bar-flavor-wheel-marks">
          {markNodes}
        </g>
        <circle cx={C} cy={C} r={INNER[0] - 2} fill="var(--surface-raised)" stroke="var(--border)" />
        {labels}
        <text x={C} y={C - (subCaption ? 5 : 0)} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={600} fill="var(--foreground)" pointerEvents="none">
          {caption}
        </text>
        {subCaption && <text x={C} y={C + 12} textAnchor="middle" dominantBaseline="central" fontSize={8.5} fill="var(--muted)" pointerEvents="none">{subCaption}</text>}
      </svg>
      {descriptorSelections.length > 0 && (
        <div aria-label="Flavor descriptor filters" className="flex w-full max-w-[360px] flex-wrap justify-center gap-2">
          {descriptorSelections.map((selection) => (
            <button
              key={`descriptor-control-${selection.id}`}
              type="button"
              aria-pressed={selected(selection, selectedIds)}
              onClick={() => onToggle(selection)}
              className={`chip min-h-11 px-3 text-xs ${selected(selection, selectedIds) ? "chip-active" : "hover:text-foreground"}`}
            >
              {selection.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WheelSegment({ selection, active, pressed, fill, opacity, d, onToggle, note }: { selection: FlavorSelection; active: boolean; pressed: SelectionState; fill: string; opacity: number; d: string; onToggle: (selection: FlavorSelection) => void; note?: string }) {
  const toggle = () => onToggle(selection);
  const label = note ? `${selection.label}, ${note}` : selection.label;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`Filter by ${label}`}
      aria-pressed={pressed === "mixed" ? "mixed" : pressed === "all"}
      className="cursor-pointer focus-visible:outline-none focus-visible:[&>path]:stroke-[var(--accent)] focus-visible:[&>path]:[stroke-width:3]"
      onClick={toggle}
      onKeyDown={pressableKeys(toggle)}
    >
      <path
        d={d}
        fill={fill}
        fillOpacity={opacity}
        stroke={active ? "var(--accent)" : "var(--border)"}
        strokeWidth={active ? 2 : 0.65}
        className="transition-[stroke,stroke-width] duration-150 focus-visible:stroke-[var(--accent)] focus-visible:[stroke-width:3]"
      >
        <title>{label}</title>
      </path>
    </g>
  );
}

export function matchingLeafIdsForSelection(id: string): string[] {
  const wedge = FLAVOR_WHEEL.find((item) => item.id === id);
  if (wedge) return wedge.leaves.map((leaf) => leaf.id);
  const group = Object.entries(GROUPS).flatMap(([wedgeId, groups]) => groups.map((item) => ({ wedgeId, ...item }))).find((item) => `${item.wedgeId}.${item.id}` === id);
  if (group) return group.leaves;
  return leafLabel(id) && wedgeForLeaf(id) ? [id] : [];
}
