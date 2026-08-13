import { describe, expect, it } from "vitest";
import { intensityForRadius, wheelIndex } from "@/components/wheel-gesture";

describe("tasting-wheel gesture helpers", () => {
  it("maps a wheel angle to a stable segment", () => {
    expect(wheelIndex(0, 8)).toBe(0);
    expect(wheelIndex(44.9, 8)).toBe(0);
    expect(wheelIndex(45, 8)).toBe(1);
    expect(wheelIndex(359.9, 8)).toBe(7);
  });

  it("turns outward drag distance into expressive intensity", () => {
    expect(intensityForRadius(120)).toBe(1);
    expect(intensityForRadius(136)).toBe(2);
    expect(intensityForRadius(152)).toBe(3);
  });
});
