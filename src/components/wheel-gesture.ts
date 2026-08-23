import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

/**
 * How long a finger has to rest on the wheel before the wheel takes the touch
 * over from the page. Long enough that a finger on its way into a scroll is
 * never mistaken for a hold, short enough that a deliberate hold feels direct.
 */
export const WHEEL_HOLD_MS = 200;
/** Once the wheel owns the touch, this much movement — in any direction — starts the sweep. */
export const WHEEL_ACTIVATION_DISTANCE = 8;
/** Movement this far before the hold completes means the touch was a scroll; give it back to the page. */
export const WHEEL_HOLD_SLOP = 10;

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

type PointerPosition = Pick<ReactPointerEvent<SVGSVGElement>, "clientX" | "clientY">;

function travelled(start: PointerPosition, current: PointerPosition): number {
  return Math.hypot(current.clientX - start.clientX, current.clientY - start.clientY);
}

/**
 * After the hold has claimed the touch, any deliberate movement starts the
 * sweep. Direction is deliberately not consulted: the wheel's own gesture is
 * radial, so sweeping out to a descriptor at twelve o'clock is a straight
 * *vertical* drag — the very motion an axis test would refuse.
 */
export function shouldActivateWheelGesture(
  start: PointerPosition,
  current: PointerPosition,
): boolean {
  return travelled(start, current) >= WHEEL_ACTIVATION_DISTANCE;
}

/**
 * Before the hold completes, the page still owns the touch. A finger that has
 * already moved is scrolling, so the wheel drops the hold rather than arming
 * behind the scroll and stealing the rest of the gesture.
 */
export function shouldAbandonWheelHold(
  start: PointerPosition,
  current: PointerPosition,
): boolean {
  return travelled(start, current) >= WHEEL_HOLD_SLOP;
}

export function shouldStartWheelGesture(
  event: Pick<ReactPointerEvent<SVGSVGElement>, "pointerType" | "button">,
): boolean {
  // Mouse keeps ordinary click behavior. Touch and pen get the one-handed
  // tasting gesture without stealing desktop selection/focus semantics.
  return event.pointerType !== "mouse" && (event.button === 0 || event.button === -1);
}

/**
 * Lets a wheel hand the page back its scroll until a hold claims the touch.
 *
 * `touch-action` alone cannot express that: the browser latches it when the
 * finger lands, so an element that scrolls the page on touch-down can never
 * take that touch back. A non-passive `touchmove` listener can — preventing
 * the first move after the hold stops the page before it has scrolled a pixel,
 * and keeps it still for the rest of the sweep. Until the wheel locks, nothing
 * is prevented and the page scrolls exactly as it would anywhere else.
 */
export function useWheelScrollLock<T extends Element>() {
  const wheelRef = useRef<T | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    const node = wheelRef.current;
    if (!node) return;
    const onTouchMove = (event: Event) => {
      if (locked.current && event.cancelable) event.preventDefault();
    };
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => node.removeEventListener("touchmove", onTouchMove);
  }, []);

  const lockScroll = useCallback(() => {
    locked.current = true;
  }, []);
  const releaseScroll = useCallback(() => {
    locked.current = false;
  }, []);

  return { wheelRef, lockScroll, releaseScroll };
}
