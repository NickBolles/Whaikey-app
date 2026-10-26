// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EnrichedChart, SpendChart } from "./charts";

afterEach(cleanup);

const days = ["2026-10-24", "2026-10-25", "2026-10-26"];
const zero = { keyword: 0, model: 0, model_web: 0, community: 0 };

describe("SpendChart", () => {
  it("draws a bar per day, flags days over the cap and summarises for screen readers", () => {
    const { container } = render(
      <SpendChart
        capUsd={2}
        series={[
          { day: days[0], usd: 0, calls: 0 },
          { day: days[1], usd: 2.4, calls: 30 },
          { day: days[2], usd: 0.5, calls: 6 },
        ]}
      />,
    );
    const img = screen.getByRole("img");
    expect(img.getAttribute("aria-label")).toContain("$2.90 in total, cap $2.00 per day, 1 day over the cap");
    expect(container.querySelectorAll("rect")).toHaveLength(3);
    expect(container.querySelectorAll("rect.fill-danger")).toHaveLength(1);
    expect(screen.getByText("cap $2.00")).toBeTruthy();
    expect(container.querySelector("rect title")?.textContent).toBe("2026-10-24 · $0.000 · 0 calls");
  });
});

describe("EnrichedChart", () => {
  it("stacks tiers per day with a legend of totals", () => {
    const { container } = render(
      <EnrichedChart
        series={[
          { day: days[0], byTier: { ...zero }, total: 0 },
          { day: days[1], byTier: { ...zero, model: 1200, model_web: 40 }, total: 1240 },
          { day: days[2], byTier: { ...zero, model_web: 12, community: 1 }, total: 13 },
        ]}
      />,
    );
    expect(screen.getByText("1,253 bottles · peak 1,240/day")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("52 model + web");
    // 2 + 2 stacked segments, plus 4 legend swatches.
    expect(container.querySelectorAll("svg[role=img] rect")).toHaveLength(4);
    expect(screen.getByRole("list", { name: "Tiers" }).textContent).toContain("model 1,200");
  });
});
