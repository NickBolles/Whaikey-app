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

  it("paints every label after every arc so neighbours can't slice them", () => {
    const { container } = render(<FlavorWheel leafHeat={{ campfire: 1, vanilla: 0.8 }} />);
    const nodes = Array.from(container.querySelectorAll("path, text"));
    const lastArc = nodes.findLastIndex((n) => n.tagName.toLowerCase() === "path");
    const firstLabel = nodes.findIndex((n) => n.tagName.toLowerCase() === "text");
    expect(firstLabel).toBeGreaterThan(lastArc);
  });

  it("keeps leaf labels inside the ring, condensing the ones that would spill", () => {
    const { container } = render(<FlavorWheel leafHeat={{ campfire: 1, oak: 1 }} />);
    const byText = (t: string) =>
      Array.from(container.querySelectorAll("text")).find((n) => n.textContent === t)!;
    // "Campfire smoke" is wider than the ring band -> clamped to it.
    const long = byText("Campfire smoke");
    expect(long).toHaveAttribute("lengthAdjust", "spacingAndGlyphs");
    expect(Number(long.getAttribute("textLength"))).toBeGreaterThan(0);
    // "Oak" fits comfortably -> left at its natural width, no distortion.
    expect(byText("Oak")).not.toHaveAttribute("textLength");
  });

  it("darkens label ink on hot segments, which render light and near-opaque", () => {
    const { container } = render(
      <FlavorWheel wedgeHeat={{ sweet: 1, floral: 0 }} leafHeat={{ vanilla: 1, cherry: 0.5 }} />,
    );
    const byText = (t: string) =>
      Array.from(container.querySelectorAll("text")).find((n) => n.textContent === t)!;
    // Hot sweet wedge / hot pale vanilla leaf -> dark ink.
    expect(byText("Sweet")).toHaveAttribute("fill", "#16110c");
    expect(byText("Vanilla")).toHaveAttribute("fill", "#16110c");
    // Ghosted floral wedge and the mid-dark cherry leaf keep the cream ink.
    expect(byText("Floral")).toHaveAttribute("fill", "var(--foreground)");
    expect(byText("Cherry")).toHaveAttribute("fill", "var(--foreground)");
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
