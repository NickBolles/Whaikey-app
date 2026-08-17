// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PourSizePicker, snapPourSize } from "@/components/pour-size-picker";

afterEach(cleanup);

describe("snapPourSize", () => {
  it("magnetizes values near common pour sizes without losing custom values", () => {
    expect(snapPourSize(16)).toBe(15);
    expect(snapPourSize(27)).toBe(25);
    expect(snapPourSize(43)).toBe(45);
    expect(snapPourSize(37)).toBe(37);
  });
});

describe("PourSizePicker", () => {
  it("uses a labeled, ticked slider with the normal 45 ml pour selected by default", () => {
    const onChange = vi.fn();
    render(<PourSizePicker value={45} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: "Pour size" });
    expect(slider).toHaveAttribute("value", "45");
    expect(slider).toHaveAttribute("min", "15");
    expect(slider).toHaveAttribute("max", "60");
    expect(screen.getByText("45 ml — normal pour")).toBeInTheDocument();
    expect(screen.getByText("15 ml")).toBeInTheDocument();
    expect(screen.getByText("25 ml")).toBeInTheDocument();
    expect(screen.getAllByTestId("pour-size-tick")).toHaveLength(5);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("snaps a near-marker slider adjustment while retaining custom amounts", () => {
    const onChange = vi.fn();
    render(<PourSizePicker value={45} onChange={onChange} />);

    fireEvent.change(screen.getByRole("slider", { name: "Pour size" }), { target: { value: "27" } });
    expect(onChange).toHaveBeenLastCalledWith(25);

    fireEvent.change(screen.getByRole("slider", { name: "Pour size" }), { target: { value: "37" } });
    expect(onChange).toHaveBeenLastCalledWith(37);
  });
});
