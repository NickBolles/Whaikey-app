import type { KeyboardEvent } from "react";

/**
 * Shared SVG geometry + palette helpers for the flavor wheel surfaces
 * (FlavorWheelInput for note capture, FlavorWheelExplorer in Whiskey School).
 * All angle args are degrees clockwise from 12 o'clock; `c` is the square
 * viewBox's center coordinate.
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
