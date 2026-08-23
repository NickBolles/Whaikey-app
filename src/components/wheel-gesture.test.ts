import { describe, expect, it } from "vitest";
import {
  intensityForRadius,
  shouldAbandonWheelHold,
  shouldActivateWheelGesture,
  wheelIndex,
} from "@/components/wheel-gesture";

describe("tasting-wheel gesture helpers", () => {
  it("maps a wheel angle to a stable segment", () => {
    expect(wheelIndex(0, 8)).toBe(0);
    expect(wheelIndex(44.9, 8)).toBe(0);
    expect(wheelIndex(45, 8)).toBe(1);
    expect(wheelIndex(359.9, 8)).toBe(7);
  });

  it("activates on a deliberate sweep in any direction, since the gesture is radial", () => {
    const start = { clientX: 170, clientY: 170 };
    expect(shouldActivateWheelGesture(start, { clientX: 170, clientY: 170 })).toBe(false);
    expect(shouldActivateWheelGesture(start, { clientX: 173, clientY: 172 })).toBe(false);
    expect(shouldActivateWheelGesture(start, { clientX: 182, clientY: 173 })).toBe(true);
    // Reaching the descriptors at twelve o'clock is a straight vertical drag.
    expect(shouldActivateWheelGesture(start, { clientX: 171, clientY: 140 })).toBe(true);
  });

  it("abandons the hold once the finger has travelled, so the page keeps its scroll", () => {
    const start = { clientX: 170, clientY: 170 };
    expect(shouldAbandonWheelHold(start, { clientX: 172, clientY: 174 })).toBe(false);
    expect(shouldAbandonWheelHold(start, { clientX: 170, clientY: 200 })).toBe(true);
    expect(shouldAbandonWheelHold(start, { clientX: 200, clientY: 170 })).toBe(true);
  });

  it("turns outward drag distance into expressive intensity", () => {
    expect(intensityForRadius(120)).toBe(1);
    expect(intensityForRadius(136)).toBe(2);
    expect(intensityForRadius(152)).toBe(3);
  });
});
