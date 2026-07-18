// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FillGauge } from "./fill-gauge";

afterEach(cleanup);

function fillHeight(level: number): number {
  render(<FillGauge level={level} />);
  const rect = screen.getByTestId("fill-gauge-fill");
  const height = Number.parseFloat(rect.getAttribute("height") ?? "NaN");
  cleanup();
  return height;
}

describe("FillGauge", () => {
  it("renders proportional fill for a given level", () => {
    const h100 = fillHeight(100);
    const h50 = fillHeight(50);
    const h25 = fillHeight(25);
    expect(h100).toBeGreaterThan(0);
    expect(h50).toBeCloseTo(h100 / 2, 5);
    expect(h25).toBeCloseTo(h100 / 4, 5);
  });

  it("renders zero height when empty and clamps out-of-range levels", () => {
    expect(fillHeight(0)).toBe(0);
    expect(fillHeight(-20)).toBe(0);
    expect(fillHeight(150)).toBeCloseTo(fillHeight(100), 5);
  });

  it("exposes the level via an accessible label", () => {
    render(<FillGauge level={65} />);
    expect(screen.getByRole("img", { name: "65% full" })).toBeInTheDocument();
  });

  it("treats a null level as empty", () => {
    render(<FillGauge level={null} />);
    const rect = screen.getByTestId("fill-gauge-fill");
    expect(Number.parseFloat(rect.getAttribute("height") ?? "NaN")).toBe(0);
    expect(screen.getByRole("img", { name: "0% full" })).toBeInTheDocument();
  });
});
