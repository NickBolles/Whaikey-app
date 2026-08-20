import type { ReactNode } from "react";
import { FLAVOR_WHEEL, leafLabel } from "@/lib/flavor-wheel";
import { leafShade, warmify } from "@/components/wheel-geometry";

/**
 * Every leaf's own color, graded within its family exactly the way the wheel
 * paints it — a chip and the wheel segment for the same flavor always match.
 */
const LEAF_COLOR = new Map<string, string>();
for (const wedge of FLAVOR_WHEEL) {
  const family = warmify(wedge.color);
  wedge.leaves.forEach((leaf, i) => {
    LEAF_COLOR.set(leaf.id, leafShade(family, i, wedge.leaves.length));
  });
}

export function leafColor(leafId: string): string {
  return LEAF_COLOR.get(leafId) ?? "var(--muted)";
}

/**
 * Intensity as a 1-3 meter: always three dots, the unearned ones dimmed rather
 * than absent.
 *
 * Two reasons it is not a repeated glyph. Constant width — a row of chips at
 * mixed intensities keeps its rhythm, and a chip doesn't resize when someone
 * edits the level. And it has to be unmistakably a *reading*, not a control:
 * the previous "×"/"××" rendering sat exactly where a remove affordance sits
 * and was read as one — next to a real ✕ remove button, in the pour sheet.
 * Dots can't be mistaken for a close box.
 */
export function IntensityDots({
  intensity,
  className = "",
}: {
  intensity: number;
  className?: string;
}) {
  const filled = Math.max(1, Math.min(3, Math.round(intensity)));
  return (
    <span
      role="img"
      aria-label={`intensity ${filled} of 3`}
      className={`inline-flex shrink-0 items-center gap-[1.5px] text-[7px] leading-none ${className}`}
    >
      {[1, 2, 3].map((n) => (
        <span key={n} aria-hidden className={n <= filled ? "opacity-100" : "opacity-25"}>
          ●
        </span>
      ))}
    </span>
  );
}

export type FlavorChipVariant = "solid" | "confirmed" | "suggested";

export interface FlavorChipProps {
  leafId: string;
  /** 1-3; rendered as ● dots after the label. */
  intensity?: number | null;
  /**
   * solid — the default, for lists and feeds: the leaf's own wheel color.
   * confirmed — "the producer said this too": amber tint, ✓ prefix.
   * suggested — "they got this, you didn't": dashed outline, + prefix.
   */
  variant?: FlavorChipVariant;
  /** Present on suggested chips that add the flavor to your note on tap. */
  onClick?: () => void;
  "aria-label"?: string;
}

/**
 * THE way a flavor is named anywhere in the app — a pill in the flavor's own
 * color from the wheel taxonomy, never a neutral grey. No ad-hoc flavor pills.
 */
export function FlavorChip({
  leafId,
  intensity,
  variant = "solid",
  onClick,
  "aria-label": ariaLabel,
}: FlavorChipProps) {
  const label = leafLabel(leafId) ?? leafId;
  const clamped = intensity != null ? Math.max(1, Math.min(3, Math.round(intensity))) : null;

  const base =
    "inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11.5px] font-semibold leading-tight";
  let className = base;
  let style: React.CSSProperties | undefined;
  let prefix: ReactNode = null;
  if (variant === "solid") {
    className = `${base} text-[#14100b]`;
    style = { backgroundColor: leafColor(leafId) };
  } else if (variant === "confirmed") {
    className = `${base} border border-accent/55 bg-accent/10 text-accent`;
    prefix = <span aria-hidden>✓</span>;
  } else {
    className = `${base} border border-dashed border-border-subtle text-muted`;
    prefix = <span aria-hidden>+</span>;
  }

  const body = (
    <>
      {prefix}
      {label}
      {clamped != null && <IntensityDots intensity={clamped} className="opacity-80" />}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel ?? label}
        className={`${className} tap-target transition-colors hover:text-foreground`}
        style={style}
        data-testid="flavor-chip"
        data-variant={variant}
      >
        {body}
      </button>
    );
  }
  return (
    <span
      className={className}
      style={style}
      aria-label={ariaLabel}
      data-testid="flavor-chip"
      data-variant={variant}
    >
      {body}
    </span>
  );
}
