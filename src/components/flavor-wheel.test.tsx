// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";
import { FlavorHeatLegend, FlavorWheel } from "@/components/flavor-wheel";
import { leafShade, warmify } from "@/components/wheel-geometry";

afterEach(cleanup);

const LEAF_COUNT = FLAVOR_WHEEL.reduce((n, w) => n + w.leaves.length, 0);

describe("FlavorWheel", () => {
  it("renders every wedge and every leaf subsection, even with no heat", () => {
    const { container } = render(<FlavorWheel />);
    const leaves = container.querySelectorAll("[data-leaf-id]");
    expect(leaves).toHaveLength(LEAF_COUNT);
    // Wedge family names are drawn on the inner ring (also present in
    // accessible <title>s, so allow multiple matches).
    expect(screen.getAllByText("Fruity").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Peaty").length).toBeGreaterThan(0);
  });

  it("exposes leaf heat and labels the hottest leaves in place", () => {
    const { container } = render(
      <FlavorWheel leafHeat={{ campfire: 1, vanilla: 0.5, oak: 0.2 }} />,
    );
    expect(container.querySelector('[data-leaf-id="campfire"]')).toHaveAttribute(
      "data-heat",
      "1.00",
    );
    expect(container.querySelector('[data-leaf-id="oak"]')).toHaveAttribute("data-heat", "0.20");
    // Above the label threshold -> written on the wheel; below -> not.
    expect(screen.getByText("Campfire smoke")).toBeInTheDocument();
    expect(screen.getByText("Vanilla")).toBeInTheDocument();
    expect(screen.queryByText("Oak")).not.toBeInTheDocument();
  });

  it("renders caption and sub-caption in the hub", () => {
    render(<FlavorWheel caption="Your bar" subCaption="leans peaty & sweet" />);
    expect(screen.getByText("Your bar")).toBeInTheDocument();
    expect(screen.getByText("leans peaty & sweet")).toBeInTheDocument();
  });

  it("grades leaf shades within a family so subsections are distinct", () => {
    const family = warmify("#5b6b74");
    const shades = [0, 1, 2].map((i) => leafShade(family, i, 3));
    expect(new Set(shades).size).toBe(3);
  });
});

describe("FlavorHeatLegend", () => {
  it("lists the hottest leaves, capped, hottest first", () => {
    render(
      <FlavorHeatLegend
        leafHeat={{ campfire: 1, vanilla: 0.8, oak: 0.6, brine: 0.4, cherry: 0.2, pear: 0.1 }}
        max={5}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("Campfire smoke");
    expect(screen.queryByText("Pear")).not.toBeInTheDocument();
  });

  it("renders nothing when there is no heat", () => {
    const { container } = render(<FlavorHeatLegend leafHeat={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
