import type { KeyboardEvent } from "react";

/**
 * Shared SVG geometry + palette helpers for the flavor wheel surfaces
 * (FlavorWheelInput for note capture, FlavorWheelExplorer in Whiskey School,
 * FlavorWheel heat map in My Bar). All angle args are degrees clockwise from
 * 12 o'clock; `c` is the square viewBox's center coordinate.
 */

export const SERIF = "var(--font-fraunces), Georgia, serif";

/** Nudge a wedge hue toward the warm brass palette so the wheel sits in the room. */
export function warmify(hex: string): string {
  const warm = [185, 141, 79]; // brass midpoint (#b98d4f)
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mixed = rgb.map((ch, i) => Math.round(ch * 0.78 + warm[i] * 0.22));
  return `#${mixed.map((ch) => ch.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Grade a wedge color across its leaves so subsections read as distinct
 * bands of the same family (classic printed-wheel look): first leaf lightest,
 * last leaf deepest.
 */
export function leafShade(hex: string, index: number, count: number): string {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const t = count <= 1 ? 0.5 : index / (count - 1);
  // Mix toward cream at t=0 and toward near-black at t=1, gently.
  const lighten = 0.28 * (1 - t);
  const darken = 0.22 * t;
  const mixed = rgb.map((ch) => {
    const up = ch + (244 - ch) * lighten;
    return Math.round(up * (1 - darken));
  });
  return `#${mixed.map((ch) => Math.max(0, Math.min(255, ch)).toString(16).padStart(2, "0")).join("")}`;
}

export function polar(c: number, r: number, deg: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180;
  return { x: c + r * Math.sin(a), y: c - r * Math.cos(a) };
}

/** Donut-segment path between two radii. */
export function arcPath(
  c: number,
  rIn: number,
  rOut: number,
  startDeg: number,
  endDeg: number,
  padDeg = 1.2,
): string {
  const a0 = startDeg + padDeg;
  const a1 = endDeg - padDeg;
  const p1 = polar(c, rOut, a0);
  const p2 = polar(c, rOut, a1);
  const p3 = polar(c, rIn, a1);
  const p4 = polar(c, rIn, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  const f = (n: number) => n.toFixed(2);
  return [
    `M ${f(p1.x)} ${f(p1.y)}`,
    `A ${rOut} ${rOut} 0 ${large} 1 ${f(p2.x)} ${f(p2.y)}`,
    `L ${f(p3.x)} ${f(p3.y)}`,
    `A ${rIn} ${rIn} 0 ${large} 0 ${f(p4.x)} ${f(p4.y)}`,
    "Z",
  ].join(" ");
}

/** Tangential label transform, flipped on the bottom half so text stays upright. */
export function labelTransform(c: number, r: number, deg: number): string {
  const { x, y } = polar(c, r, deg);
  const norm = ((deg % 360) + 360) % 360;
  const rot = norm > 90 && norm < 270 ? deg + 180 : deg;
  return `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(2)})`;
}

/**
 * Radial (spoke) label transform for dense outer rings: text runs along the
 * radius, flipped on the left half so it always reads outward.
 */
export function radialLabelTransform(
  c: number,
  r: number,
  deg: number,
): { transform: string; anchor: "start" | "end" } {
  const { x, y } = polar(c, r, deg);
  const norm = ((deg % 360) + 360) % 360;
  const flip = norm > 180;
  const rot = flip ? deg + 90 : deg - 90;
  return {
    transform: `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(2)})`,
    anchor: flip ? "end" : "start",
  };
}

/**
 * Radial (spoke) label placed so it always stays *inside* a ring band. The
 * anchor sits at the band's inner edge and the text grows outward; when the
 * label's natural width would spill past the outer edge (or off the viewBox)
 * it is condensed to exactly the band width via `textLength`. Flipped on the
 * left half so it stays upright.
 */
export interface BandLabel {
  transform: string;
  anchor: "start" | "end";
  /** Present only when the label had to be condensed to fit the band. */
  textLength?: number;
}

/** Rough advance width of one glyph of the wheel's bold sans, in ems. */
const AVG_GLYPH_EM = 0.55;
/** Headroom over the estimate before we clamp, covering per-string variance. */
const FIT_SLACK = 1.3;

export function bandLabelTransform(
  c: number,
  rIn: number,
  rOut: number,
  deg: number,
  text: string,
  fontSize: number,
  pad = 4,
): BandLabel {
  const band = Math.max(0, rOut - rIn - pad * 2);
  const natural = text.length * fontSize * AVG_GLYPH_EM;
  const fits = natural * FIT_SLACK <= band;
  const { x, y } = polar(c, rIn + pad, deg);
  const norm = ((deg % 360) + 360) % 360;
  const flip = norm > 180;
  const rot = flip ? deg + 90 : deg - 90;
  return {
    transform: `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(2)})`,
    anchor: flip ? "end" : "start",
    textLength: fits ? undefined : band,
  };
}

type RGB = [number, number, number];

/** Card surface the wheel is composited over (surface gradient midpoint). */
const BACKDROP: RGB = [36, 29, 21];
const DARK_INK = "#16110c";
const LIGHT_INK = "var(--foreground)";
const DARK_INK_RGB: RGB = [22, 17, 12];
const LIGHT_INK_RGB: RGB = [244, 236, 221];

function toRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance([r, g, b]: RGB): number {
  const lin = [r, g, b].map((ch) => {
    const s = ch / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Pick the label ink with the most contrast against a wheel segment. Heat is
 * drawn as fill opacity, so the same base color can end up anywhere between
 * "ghosted over a dark card" (needs the cream foreground) and "near-opaque
 * light brass" (needs dark ink) — compositing first is what keeps hot
 * segments' labels readable.
 */
export function inkOn(fillHex: string, fillOpacity: number): string {
  const fill = toRgb(fillHex);
  const composited = fill.map(
    (ch, i) => ch * fillOpacity + BACKDROP[i] * (1 - fillOpacity),
  ) as RGB;
  const l = relativeLuminance(composited);
  return contrast(l, relativeLuminance(DARK_INK_RGB)) >=
    contrast(l, relativeLuminance(LIGHT_INK_RGB))
    ? DARK_INK
    : LIGHT_INK;
}

export function shortLabel(label: string): string {
  return label.split(" / ")[0];
}

export function pressableKeys(handler: () => void) {
  return (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}
