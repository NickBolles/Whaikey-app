import type { PointerEvent as ReactPointerEvent } from "react";

/** Brief enough to feel direct, while a stationary hold and vertical move still scroll natively. */
export const WHEEL_HOLD_MS = 140;
/** A small but deliberate sideways nudge unlocks the wheel without stealing a vertical scroll. */
export const WHEEL_ACTIVATION_DISTANCE = 8;

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

/**
 * A stationary long-press is reserved for normal browser behavior (including
 * scrolling). The wheel only claims a touch after a deliberate sideways drag.
 */
export function shouldActivateWheelGesture(
  start: Pick<ReactPointerEvent<SVGSVGElement>, "clientX" | "clientY">,
  current: Pick<ReactPointerEvent<SVGSVGElement>, "clientX" | "clientY">,
): boolean {
  const horizontal = Math.abs(current.clientX - start.clientX);
  const vertical = Math.abs(current.clientY - start.clientY);
  return horizontal >= WHEEL_ACTIVATION_DISTANCE && horizontal > vertical;
}

export function shouldStartWheelGesture(
  event: Pick<ReactPointerEvent<SVGSVGElement>, "pointerType" | "button">,
): boolean {
  // Mouse keeps ordinary click behavior. Touch and pen get the one-handed
  // tasting gesture without stealing desktop selection/focus semantics.
  return event.pointerType !== "mouse" && (event.button === 0 || event.button === -1);
}
