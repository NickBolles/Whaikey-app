// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "Filter by Vanilla" }));
    expect(onToggle).toHaveBeenCalledWith({ id: "vanilla", label: "Vanilla", leafIds: ["vanilla"] });
  });
});
