// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { haptic } = vi.hoisted(() => ({ haptic: vi.fn() }));
vi.mock("@/lib/native/haptics", () => ({ haptic }));
import { BarFlavorWheel } from "./bar-flavor-wheel";

afterEach(cleanup);

describe("BarFlavorWheel", () => {
  it("renders family, group, and descriptor controls and returns canonical leaf filters", () => {
    const onToggle = vi.fn();
    render(
      <BarFlavorWheel
        wedgeHeat={{ sweet: 1 }}
        leafHeat={{ vanilla: 1 }}
        caption="My notes"
        selectedIds={[]}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByRole("button", { name: "Filter by Sweet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter by Confection" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Filter by Vanilla" })[0]);
    expect(onToggle).toHaveBeenCalledWith({ id: "vanilla", label: "Vanilla", leafIds: ["vanilla"] });
  });

  it("keeps partial ancestor selection visually active but exposes it as mixed", () => {
    render(
      <BarFlavorWheel
        wedgeHeat={{ sweet: 1 }}
        leafHeat={{ vanilla: 1 }}
        caption="My notes"
        selectedIds={["vanilla"]}
        onToggle={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Filter by Sweet" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getByRole("button", { name: "Filter by Confection" })).toHaveAttribute("aria-pressed", "mixed");
    expect(screen.getAllByRole("button", { name: "Filter by Vanilla" })[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("offers heated descriptors as 44px touch-friendly controls", () => {
    const onToggle = vi.fn();
    render(
      <BarFlavorWheel
        wedgeHeat={{ sweet: 1 }}
        leafHeat={{ vanilla: 1 }}
        caption="My notes"
        selectedIds={[]}
        onToggle={onToggle}
      />,
    );

    const controls = screen.getByLabelText("Flavor descriptor filters");
    const vanilla = controls.querySelector("button")!;
    expect(vanilla).toHaveClass("min-h-11");
    fireEvent.click(vanilla);
    expect(onToggle).toHaveBeenCalledWith({ id: "vanilla", label: "Vanilla", leafIds: ["vanilla"] });
  });
});
