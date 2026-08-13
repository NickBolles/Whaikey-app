import { describe, expect, it } from "vitest";
import { intensityForRadius, shouldActivateWheelGesture, wheelIndex } from "@/components/wheel-gesture";

describe("tasting-wheel gesture helpers", () => {
  it("maps a wheel angle to a stable segment", () => {
    expect(wheelIndex(0, 8)).toBe(0);
    expect(wheelIndex(44.9, 8)).toBe(0);
    expect(wheelIndex(45, 8)).toBe(1);
    expect(wheelIndex(359.9, 8)).toBe(7);
  });

  it("does not activate for a long press or vertical scroll, but accepts a deliberate sideways drag", () => {
    const start = { clientX: 170, clientY: 170 };
    expect(shouldActivateWheelGesture(start, { clientX: 170, clientY: 170 })).toBe(false);
    expect(shouldActivateWheelGesture(start, { clientX: 172, clientY: 220 })).toBe(false);
    expect(shouldActivateWheelGesture(start, { clientX: 182, clientY: 173 })).toBe(true);
  });

  it("turns outward drag distance into expressive intensity", () => {
    expect(intensityForRadius(120)).toBe(1);
    expect(intensityForRadius(136)).toBe(2);
    expect(intensityForRadius(152)).toBe(3);
  });
});
