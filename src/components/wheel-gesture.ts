import type { PointerEvent as ReactPointerEvent } from "react";

export const WHEEL_HOLD_MS = 220;

export type WheelPoint = {
  angle: number;
  radius: number;
};

/**
 * Convert a pointer position inside an SVG wheel into its 340×340 viewBox
 * coordinates. Keeping this calculation shared makes every flavor-wheel
 * surface use the same hold-and-drag language.
 */
export function wheelPointFromPointer(
  event: Pick<ReactPointerEvent<SVGSVGElement>, "currentTarget" | "clientX" | "clientY">,
  size = 340,
): WheelPoint {
  return wheelPointFromClient(event.currentTarget, event.clientX, event.clientY, size);
}

/** Safe to call from a delayed hold timer: it receives the SVG itself, not a
 * React SyntheticEvent whose currentTarget is only valid during dispatch. */
export function wheelPointFromClient(
  target: SVGSVGElement,
  clientX: number,
  clientY: number,
  size = 340,
): WheelPoint {
  const box = target.getBoundingClientRect();
  const x = ((clientX - box.left) / box.width) * size - size / 2;
  const y = ((clientY - box.top) / box.height) * size - size / 2;
  const radius = Math.hypot(x, y);
  // Wheel geometry is clockwise from twelve o'clock.
  const angle = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
  return { angle, radius };
}

export function wheelIndex(angle: number, count: number): number {
  return Math.min(count - 1, Math.floor(angle / (360 / count)));
}

export function intensityForRadius(radius: number): 1 | 2 | 3 {
  if (radius >= 152) return 3;
  if (radius >= 136) return 2;
  return 1;
}

export function shouldStartWheelGesture(
  event: Pick<ReactPointerEvent<SVGSVGElement>, "pointerType" | "button">,
): boolean {
  // Mouse keeps ordinary click behavior. Touch and pen get the one-handed
  // tasting gesture without stealing desktop selection/focus semantics.
  return event.pointerType !== "mouse" && (event.button === 0 || event.button === -1);
}
