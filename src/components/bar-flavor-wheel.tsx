import type { ReactNode } from "react";
import { FLAVOR_WHEEL, leafLabel, wedgeForLeaf } from "@/lib/flavor-wheel";
import { arcPath, bandLabelTransform, inkOn, labelTransform, leafShade, pressableKeys, shortLabel, warmify } from "@/components/wheel-geometry";

export type FlavorSelection = {
  id: string;
  label: string;
  leafIds: string[];
};

export interface BarFlavorWheelProps {
  wedgeHeat: Record<string, number>;
  leafHeat: Record<string, number>;
  caption: string;
  subCaption?: string;
  selectedIds: string[];
  onToggle: (selection: FlavorSelection) => void;
}

const SIZE = 340;
const C = SIZE / 2;
const INNER = [48, 79] as const;
const MIDDLE = [83, 112] as const;
const OUTER = [116, 162] as const;

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

function selected(selection: FlavorSelection, selectedIds: string[]): boolean {
  return selection.leafIds.some((id) => selectedIds.includes(id));
}

/**
 * Interactive three-ring bar wheel. Rings are family → flavor group → descriptor;
 * every segment sends canonical leaf ids back to the Bar filter, so personal and
 * published modes always use the same taxonomy.
 */
export function BarFlavorWheel({ wedgeHeat, leafHeat, caption, subCaption, selectedIds, onToggle }: BarFlavorWheelProps) {
  const wedgeSpan = 360 / FLAVOR_WHEEL.length;
  const segments: ReactNode[] = [];
  const labels: ReactNode[] = [];

  FLAVOR_WHEEL.forEach((wedge, wedgeIndex) => {
    const start = wedgeIndex * wedgeSpan;
    const color = warmify(wedge.color);
    const family: FlavorSelection = { id: wedge.id, label: wedge.label, leafIds: wedge.leaves.map((leaf) => leaf.id) };
    const familyHeat = clamp01(wedgeHeat[wedge.id] ?? 0);
    const familyOpacity = 0.16 + familyHeat * 0.72;
    const familyActive = selected(family, selectedIds);
    const familyMid = start + wedgeSpan / 2;
    segments.push(
      <WheelSegment key={`family-${wedge.id}`} selection={family} active={familyActive} fill={color} opacity={familyOpacity} d={arcPath(C, INNER[0], INNER[1], start, start + wedgeSpan)} onToggle={onToggle} />,
    );
    labels.push(
      <text key={`family-label-${wedge.id}`} transform={labelTransform(C, (INNER[0] + INNER[1]) / 2, familyMid)} textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill={inkOn(color, familyOpacity)} pointerEvents="none">
        {shortLabel(wedge.label)}
      </text>,
    );

    const groups = GROUPS[wedge.id] ?? [];
    const groupSpan = wedgeSpan / groups.length;
    groups.forEach((group, groupIndex) => {
      const groupStart = start + groupIndex * groupSpan;
      const groupMid = groupStart + groupSpan / 2;
      const groupSelection: FlavorSelection = { id: `${wedge.id}.${group.id}`, label: group.label, leafIds: group.leaves };
      const groupHeat = heatForLeaves(group.leaves, leafHeat);
      const groupOpacity = 0.14 + Math.max(groupHeat, familyHeat * 0.45) * 0.72;
      const groupActive = selected(groupSelection, selectedIds);
      segments.push(
        <WheelSegment key={`group-${groupSelection.id}`} selection={groupSelection} active={groupActive} fill={color} opacity={groupOpacity} d={arcPath(C, MIDDLE[0], MIDDLE[1], groupStart, groupStart + groupSpan)} onToggle={onToggle} />,
      );
      const groupText = bandLabelTransform(C, MIDDLE[0], MIDDLE[1], groupMid, group.label, 7);
      labels.push(
        <text key={`group-label-${groupSelection.id}`} transform={groupText.transform} textAnchor={groupText.anchor} textLength={groupText.textLength} lengthAdjust={groupText.textLength ? "spacingAndGlyphs" : undefined} dominantBaseline="central" fontSize={7} fontWeight={700} fill={inkOn(color, groupOpacity)} pointerEvents="none">
          {group.label}
        </text>,
      );
    });

    const leafSpan = wedgeSpan / wedge.leaves.length;
    wedge.leaves.forEach((leaf, leafIndex) => {
      const leafStart = start + leafIndex * leafSpan;
      const leafMid = leafStart + leafSpan / 2;
      const leafSelection: FlavorSelection = { id: leaf.id, label: leaf.label, leafIds: [leaf.id] };
      const descriptorHeat = clamp01(leafHeat[leaf.id] ?? 0);
      const shade = leafShade(color, leafIndex, wedge.leaves.length);
      const opacity = 0.12 + descriptorHeat * 0.8;
      segments.push(
        <WheelSegment key={`leaf-${leaf.id}`} selection={leafSelection} active={selected(leafSelection, selectedIds)} fill={shade} opacity={opacity} d={arcPath(C, OUTER[0], OUTER[1], leafStart, leafStart + leafSpan, Math.min(0.75, leafSpan / 8))} onToggle={onToggle} />,
      );
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

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full max-w-[360px] select-none" role="group" aria-label={`${caption} flavor wheel`} data-testid="bar-flavor-wheel">
      {segments}
      <circle cx={C} cy={C} r={INNER[0] - 2} fill="var(--surface-raised)" stroke="var(--border)" />
      {labels}
      <text x={C} y={C - (subCaption ? 5 : 0)} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={600} fill="var(--foreground)" pointerEvents="none">
        {caption}
      </text>
      {subCaption && <text x={C} y={C + 12} textAnchor="middle" dominantBaseline="central" fontSize={8.5} fill="var(--muted)" pointerEvents="none">{subCaption}</text>}
    </svg>
  );
}

function WheelSegment({ selection, active, fill, opacity, d, onToggle }: { selection: FlavorSelection; active: boolean; fill: string; opacity: number; d: string; onToggle: (selection: FlavorSelection) => void }) {
  const toggle = () => onToggle(selection);
  return (
    <g role="button" tabIndex={0} aria-label={`Filter by ${selection.label}`} aria-pressed={active} className="cursor-pointer focus-visible:outline-none" onClick={toggle} onKeyDown={pressableKeys(toggle)}>
      <path d={d} fill={fill} fillOpacity={opacity} stroke={active ? "var(--accent)" : "var(--border)"} strokeWidth={active ? 2 : 0.65}>
        <title>{selection.label}</title>
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
