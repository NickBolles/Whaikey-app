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
  it("defaults to and labels the normal 45 ml pour, while offering added 15 and 25 ml markers", () => {
    const onChange = vi.fn();
    render(<PourSizePicker value={45} onChange={onChange} />);

    expect(screen.getByRole("slider", { name: "Pour size" })).toHaveAttribute("value", "45");
    expect(screen.getByText("45 ml — normal pour")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "15 ml" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "25 ml" })).toBeInTheDocument();
  });

  it("snaps a near-marker slider adjustment and lets a marker select its exact size", () => {
    const onChange = vi.fn();
    render(<PourSizePicker value={45} onChange={onChange} />);

    fireEvent.change(screen.getByRole("slider", { name: "Pour size" }), { target: { value: "27" } });
    expect(onChange).toHaveBeenLastCalledWith(25);

    fireEvent.click(screen.getByRole("button", { name: "15 ml" }));
    expect(onChange).toHaveBeenLastCalledWith(15);
  });
});
