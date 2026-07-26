import type { ReactElement } from "react";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import {
  SERIF,
  arcPath,
  bandLabelTransform,
  inkOn,
  labelTransform,
  leafShade,
  shortLabel,
  warmify,
} from "@/components/wheel-geometry";

export interface FlavorWheelProps {
  /** Wedge id -> heat 0-1 (relative: hottest wedge in the set = 1). */
  wedgeHeat?: Record<string, number>;
  /** Leaf id -> heat 0-1. */
  leafHeat?: Record<string, number>;
  /** Center caption, e.g. "Your bar". */
  caption?: string;
  /** Small line under the caption, e.g. "leans peaty". */
  subCaption?: string;
}

const SIZE = 340;
const C = SIZE / 2;
const R_WEDGE_IN = 54;
const R_WEDGE_OUT = 96;
const R_LEAF_IN = 100;
/** Wide enough that a labeled leaf's name fits inside the band (see LEAF_FONT). */
const R_LEAF_OUT = 160;
const WEDGE_LABEL_R = (R_WEDGE_IN + R_WEDGE_OUT) / 2;
const LEAF_FONT = 8;
/** Leaves hotter than this get their name written on the wheel. */
const LEAF_LABEL_THRESHOLD = 0.45;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

interface WheelLabel {
  id: string;
  text: string;
  ink: string;
  mid: number;
}

/**
 * The full flavor wheel as a read-only heat map: all 8 wedges on the inner
 * ring and every leaf subsection on the outer ring, color-coded by family
 * (leaves are graded shades of their wedge color, like a printed tasting
 * wheel). Heat renders as opacity — cold segments stay ghosted so the whole
 * taxonomy is always visible. The hottest leaves get labeled in place.
 * Pure SVG, safe to render from server components.
 */
export function FlavorWheel({ wedgeHeat = {}, leafHeat = {}, caption, subCaption }: FlavorWheelProps) {
  const wedgeSpan = 360 / FLAVOR_WHEEL.length;

  // SVG has no z-index: anything drawn later wins. Collect the arcs and the
  // labels separately so every label can be painted in one pass on top of
  // every arc — otherwise a labeled leaf gets sliced by its neighbours' arcs.
  const wedgeArcs: ReactElement[] = [];
  const leafArcs: ReactElement[] = [];
  const wedgeLabels: WheelLabel[] = [];
  const leafLabels: WheelLabel[] = [];

  FLAVOR_WHEEL.forEach((wedge, wi) => {
    const start = wi * wedgeSpan;
    const mid = start + wedgeSpan / 2;
    const color = warmify(wedge.color);
    const heat = clamp01(wedgeHeat[wedge.id] ?? 0);
    const opacity = 0.16 + 0.72 * heat;

    wedgeArcs.push(
      <g key={wedge.id} data-wedge-id={wedge.id} data-heat={heat.toFixed(2)}>
        <path
          d={arcPath(C, R_WEDGE_IN, R_WEDGE_OUT, start, start + wedgeSpan)}
          fill={color}
          fillOpacity={opacity}
          stroke="var(--border)"
          strokeWidth={0.75}
        >
          <title>{`${wedge.label}${heat > 0 ? ` — heat ${Math.round(heat * 100)}%` : ""}`}</title>
        </path>
      </g>,
    );
    wedgeLabels.push({
      id: wedge.id,
      text: shortLabel(wedge.label),
      ink: inkOn(color, opacity),
      mid,
    });

    const span = wedgeSpan / wedge.leaves.length;
    wedge.leaves.forEach((leaf, li) => {
      const lStart = start + li * span;
      const lMid = lStart + span / 2;
      const lHeat = clamp01(leafHeat[leaf.id] ?? 0);
      const shade = leafShade(color, li, wedge.leaves.length);
      const lOpacity = 0.14 + 0.78 * lHeat;

      leafArcs.push(
        <g key={leaf.id} data-leaf-id={leaf.id} data-heat={lHeat.toFixed(2)}>
          <path
            d={arcPath(C, R_LEAF_IN, R_LEAF_OUT, lStart, lStart + span, Math.min(0.9, span / 8))}
            fill={shade}
            fillOpacity={lOpacity}
            stroke="var(--border)"
            strokeWidth={0.5}
          >
            <title>{`${leaf.label} (${wedge.label})${
              lHeat > 0 ? ` — heat ${Math.round(lHeat * 100)}%` : ""
            }`}</title>
          </path>
        </g>,
      );
      if (lHeat >= LEAF_LABEL_THRESHOLD) {
        leafLabels.push({
          id: leaf.id,
          text: shortLabel(leaf.label),
          ink: inkOn(shade, lOpacity),
          mid: lMid,
        });
      }
    });
  });

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="w-full max-w-[360px] select-none"
      role="img"
      aria-label="Flavor wheel heat map"
      data-testid="flavor-wheel"
    >
      {wedgeArcs}
      {leafArcs}
      <RingSeam />

      {wedgeLabels.map((label) => (
        <text
          key={label.id}
          transform={labelTransform(C, WEDGE_LABEL_R, label.mid)}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={10.5}
          fontWeight={600}
          fill={label.ink}
          opacity={0.92}
          pointerEvents="none"
        >
          {label.text}
        </text>
      ))}

      {leafLabels.map((label) => {
        const spoke = bandLabelTransform(
          C,
          R_LEAF_IN,
          R_LEAF_OUT,
          label.mid,
          label.text,
          LEAF_FONT,
        );
        return (
          <text
            key={label.id}
            transform={spoke.transform}
            textAnchor={spoke.anchor}
            textLength={spoke.textLength}
            lengthAdjust={spoke.textLength ? "spacingAndGlyphs" : undefined}
            dominantBaseline="central"
            fontSize={LEAF_FONT}
            fontWeight={700}
            fill={label.ink}
            pointerEvents="none"
          >
            {label.text}
          </text>
        );
      })}

      {caption && (
        <text
          x={C}
          y={C - (subCaption ? 6 : 0)}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={15}
          fontWeight={600}
          fill="var(--foreground)"
          style={{ fontFamily: SERIF }}
          pointerEvents="none"
        >
          {caption}
        </text>
      )}
      {subCaption && (
        <text
          x={C}
          y={C + 12}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={9}
          fill="var(--muted)"
          pointerEvents="none"
        >
          {subCaption}
        </text>
      )}
    </svg>
  );
}

/** Hairline circles that keep the family/subsection ring boundaries crisp. */
function RingSeam() {
  return (
    <>
      <circle cx={C} cy={C} r={R_WEDGE_OUT} fill="none" stroke="var(--border)" strokeWidth={0.5} opacity={0.6} />
      <circle cx={C} cy={C} r={R_LEAF_IN} fill="none" stroke="var(--border)" strokeWidth={0.5} opacity={0.6} />
    </>
  );
}

/**
 * Chip legend for the hottest leaves — pairs with the wheel so the heat map
 * is readable even where wedge arcs are too thin to label.
 */
export function FlavorHeatLegend({ leafHeat, max = 5 }: { leafHeat: Record<string, number>; max?: number }) {
  const top: Array<{ id: string; label: string; color: string; heat: number }> = [];
  for (const wedge of FLAVOR_WHEEL) {
    const family = warmify(wedge.color);
    for (let i = 0; i < wedge.leaves.length; i++) {
      const leaf = wedge.leaves[i];
      const heat = clamp01(leafHeat[leaf.id] ?? 0);
      if (heat > 0)
        top.push({ id: leaf.id, label: leaf.label, color: leafShade(family, i, wedge.leaves.length), heat });
    }
  }
  top.sort((a, b) => b.heat - a.heat);
  const shown = top.slice(0, max);
  if (shown.length === 0) return null;
  return (
    <ul className="flex flex-wrap justify-center gap-2" aria-label="Top flavors">
      {shown.map((leaf) => (
        <li key={leaf.id} className="chip flex items-center gap-1.5 px-3 py-1.5 text-xs">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: leaf.color }}
            aria-hidden
          />
          <span className="text-foreground/90">{leaf.label}</span>
        </li>
      ))}
    </ul>
  );
}
