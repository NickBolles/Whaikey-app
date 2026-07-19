import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import {
  SERIF,
  arcPath,
  labelTransform,
  leafShade,
  radialLabelTransform,
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
const R_LEAF_OUT = 152;
const WEDGE_LABEL_R = (R_WEDGE_IN + R_WEDGE_OUT) / 2;
/** Leaves hotter than this get their name written on the wheel. */
const LEAF_LABEL_THRESHOLD = 0.45;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
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

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="w-full max-w-[360px] select-none"
      role="img"
      aria-label="Flavor wheel heat map"
      data-testid="flavor-wheel"
    >
      {FLAVOR_WHEEL.map((wedge, wi) => {
        const start = wi * wedgeSpan;
        const end = start + wedgeSpan;
        const mid = start + wedgeSpan / 2;
        const color = warmify(wedge.color);
        const heat = clamp01(wedgeHeat[wedge.id] ?? 0);
        return (
          <g key={wedge.id}>
            <path
              d={arcPath(C, R_WEDGE_IN, R_WEDGE_OUT, start, end)}
              fill={color}
              fillOpacity={0.16 + 0.72 * heat}
              stroke="var(--border)"
              strokeWidth={0.75}
            >
              <title>{`${wedge.label}${heat > 0 ? ` — heat ${Math.round(heat * 100)}%` : ""}`}</title>
            </path>
            <text
              transform={labelTransform(C, WEDGE_LABEL_R, mid)}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={10.5}
              fontWeight={600}
              fill={heat > 0.4 ? "#16110c" : "var(--foreground)"}
              opacity={heat > 0.4 ? 0.9 : 0.75}
              pointerEvents="none"
            >
              {shortLabel(wedge.label)}
            </text>

            {wedge.leaves.map((leaf, li) => {
              const span = wedgeSpan / wedge.leaves.length;
              const lStart = start + li * span;
              const lEnd = lStart + span;
              const lMid = lStart + span / 2;
              const lHeat = clamp01(leafHeat[leaf.id] ?? 0);
              const shade = leafShade(color, li, wedge.leaves.length);
              const labeled = lHeat >= LEAF_LABEL_THRESHOLD;
              const spoke = radialLabelTransform(C, R_LEAF_IN + 5, lMid);
              return (
                <g key={leaf.id} data-leaf-id={leaf.id} data-heat={lHeat.toFixed(2)}>
                  <path
                    d={arcPath(C, R_LEAF_IN, R_LEAF_OUT, lStart, lEnd, Math.min(0.9, span / 8))}
                    fill={shade}
                    fillOpacity={0.14 + 0.78 * lHeat}
                    stroke="var(--border)"
                    strokeWidth={0.5}
                  >
                    <title>{`${leaf.label} (${wedge.label})${
                      lHeat > 0 ? ` — heat ${Math.round(lHeat * 100)}%` : ""
                    }`}</title>
                  </path>
                  {labeled && (
                    <text
                      transform={spoke.transform}
                      textAnchor={spoke.anchor}
                      dominantBaseline="central"
                      fontSize={7.5}
                      fontWeight={700}
                      fill="var(--foreground)"
                      pointerEvents="none"
                    >
                      {shortLabel(leaf.label)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}

      {/* Gap ring between families and subsections; masks arc padding seams */}
      <circle
        cx={C}
        cy={C}
        r={(R_WEDGE_OUT + R_LEAF_IN) / 2}
        fill="none"
        stroke="var(--background)"
        strokeWidth={R_LEAF_IN - R_WEDGE_OUT}
      />
      <RingSeam />

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

/** Hairline circles that keep the two rings crisp where the mask ring sits. */
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
