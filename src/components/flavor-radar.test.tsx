// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FlavorRadar } from "@/components/flavor-radar";
import { FLAVOR_WHEEL, WEDGE_IDS } from "@/lib/flavor-wheel";

afterEach(cleanup);

const fullProfile = Object.fromEntries(WEDGE_IDS.map((id, i) => [id, (i % 10) + 1]));

describe("FlavorRadar", () => {
  it("renders one polygon point per flavor wedge", () => {
    const { container } = render(<FlavorRadar profile={fullProfile} />);
    const polygon = container.querySelector('[data-testid="flavor-radar-polygon"]');
    expect(polygon).not.toBeNull();
    const points = polygon!.getAttribute("points")!.trim().split(/\s+/);
    expect(points).toHaveLength(FLAVOR_WHEEL.length);
    for (const point of points) {
      expect(point).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    }
  });

  it("labels every wedge", () => {
    render(<FlavorRadar profile={fullProfile} />);
    for (const wedge of FLAVOR_WHEEL) {
      expect(screen.getByText(wedge.label)).toBeInTheDocument();
    }
  });

  it("treats missing wedges as zero (points collapse to center)", () => {
    const { container } = render(<FlavorRadar profile={{ sweet: 10 }} size={280} />);
    const polygon = container.querySelector('[data-testid="flavor-radar-polygon"]');
    const points = polygon!.getAttribute("points")!.trim().split(/\s+/);
    expect(points).toHaveLength(FLAVOR_WHEEL.length);
    // All wedges except "sweet" sit at the center (140,140 for size 280).
    const centerish = points.filter((p) => p === "140.0,140.0");
    expect(centerish).toHaveLength(FLAVOR_WHEEL.length - 1);
  });

  it("shows an empty state without profile data", () => {
    const { container } = render(<FlavorRadar profile={null} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText(/no flavor profile/i)).toBeInTheDocument();
  });
});
