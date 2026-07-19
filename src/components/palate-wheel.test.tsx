// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PalateWheel } from "@/components/palate-wheel";
import { WEDGE_IDS } from "@/lib/flavor-wheel";

afterEach(cleanup);

function zeroVector(): Record<string, number> {
  return Object.fromEntries(WEDGE_IDS.map((id) => [id, 0]));
}

describe("PalateWheel", () => {
  it("renders the empty state when sampleSize is 0", () => {
    const { container } = render(<PalateWheel vector={zeroVector()} sampleSize={0} />);
    expect(container.querySelector('[data-testid="flavor-radar"]')).toBeNull();
    expect(screen.getByText(/blank page/i)).toBeInTheDocument();
    expect(screen.getByText(/log a few pours/i)).toBeInTheDocument();
  });

  it("renders the empty state when the vector has no positive signal", () => {
    const vector = { ...zeroVector(), peaty: -2 };
    const { container } = render(<PalateWheel vector={vector} sampleSize={4} />);
    expect(container.querySelector('[data-testid="flavor-radar"]')).toBeNull();
    expect(screen.getByText(/blank page/i)).toBeInTheDocument();
  });

  it("renders the radar and top-wedge caption for a signed vector", () => {
    const vector = { ...zeroVector(), peaty: 4, sweet: 2, woody: 1, fruity: -1 };
    const { container } = render(<PalateWheel vector={vector} sampleSize={6} />);

    expect(container.querySelector('[data-testid="flavor-radar"]')).not.toBeNull();
    // The caption chips name the top wedges, strongest first, positive only.
    // (Scope to <li> chips — the radar also renders wedge labels as SVG text.)
    const chipText = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(chipText).toEqual(["Peaty / Smoky", "Sweet", "Woody"]);
    // Negative-weighted wedge is not surfaced as a preference chip.
    expect(chipText).not.toContain("Fruity");
  });
});
