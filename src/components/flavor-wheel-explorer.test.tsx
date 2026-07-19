// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlavorWheelExplorer } from "@/components/flavor-wheel-explorer";
import { FLAVOR_WHEEL } from "@/lib/flavor-wheel";

afterEach(cleanup);

describe("FlavorWheelExplorer", () => {
  it("renders all eight wedges as tappable buttons", () => {
    render(<FlavorWheelExplorer />);
    for (const wedge of FLAVOR_WHEEL) {
      expect(screen.getByRole("button", { name: wedge.label })).toBeInTheDocument();
    }
    expect(screen.getByText(/tap a family on the wheel/i)).toBeInTheDocument();
  });

  it("shows a family's education card with its leaves when tapped", async () => {
    render(<FlavorWheelExplorer />);
    await userEvent.click(screen.getByRole("button", { name: "Sweet" }));

    expect(screen.getByRole("heading", { name: "Sweet" })).toBeInTheDocument();
    expect(screen.getByText(/Where it comes from/i)).toBeInTheDocument();
    const sweet = FLAVOR_WHEEL.find((w) => w.id === "sweet")!;
    for (const leaf of sweet.leaves) {
      expect(screen.getByText(leaf.label)).toBeInTheDocument();
    }
  });

  it("tapping the selected wedge again deselects it", async () => {
    render(<FlavorWheelExplorer />);
    const wedge = screen.getByRole("button", { name: "Peaty / Smoky" });
    await userEvent.click(wedge);
    expect(screen.getByRole("heading", { name: "Peaty / Smoky" })).toBeInTheDocument();

    await userEvent.click(wedge);
    expect(screen.queryByRole("heading", { name: "Peaty / Smoky" })).not.toBeInTheDocument();
    expect(screen.getByText(/tap a family on the wheel/i)).toBeInTheDocument();
  });
});
