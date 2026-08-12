// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FlavorWheelInput } from "@/components/flavor-wheel-input";

afterEach(cleanup);

function Harness({ initial = {} }: { initial?: Record<string, number> }) {
  const [value, setValue] = useState<Record<string, number>>(initial);
  return <FlavorWheelInput value={value} onChange={setValue} />;
}

describe("FlavorWheelInput", () => {
  it("shows the 8 wedges and hides leaves until a wedge is tapped", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Sweet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Peaty / Smoky" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Vanilla" })).not.toBeInTheDocument();
  });

  it("tapping a wedge reveals its leaves; tapping again collapses", () => {
    render(<Harness />);
    const sweet = screen.getByRole("button", { name: "Sweet" });
    fireEvent.click(sweet);
    expect(screen.getByRole("button", { name: "Vanilla" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Caramel" })).toBeInTheDocument();
    fireEvent.click(sweet);
    expect(screen.queryByRole("button", { name: "Vanilla" })).not.toBeInTheDocument();
  });

  it("tapping a leaf cycles intensity 0 -> 1 -> 2 -> 3 -> 0", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Sweet" }));

    fireEvent.click(screen.getByRole("button", { name: "Vanilla" }));
    expect(screen.getByRole("button", { name: "Vanilla, intensity 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Vanilla, intensity 1" }));
    expect(screen.getByRole("button", { name: "Vanilla, intensity 2" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Vanilla, intensity 2" }));
    expect(screen.getByRole("button", { name: "Vanilla, intensity 3" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Vanilla, intensity 3" }));
    expect(screen.getByRole("button", { name: "Vanilla" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("fires onChange with the updated tag map", () => {
    const onChange = vi.fn();
    render(<FlavorWheelInput value={{}} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Sweet" }));
    fireEvent.click(screen.getByRole("button", { name: "Vanilla" }));
    expect(onChange).toHaveBeenCalledWith({ vanilla: 1 });
  });

  it("supports keyboard activation on segments", () => {
    const onChange = vi.fn();
    render(<FlavorWheelInput value={{}} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Sweet" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Honey" }), { key: " " });
    expect(onChange).toHaveBeenCalledWith({ honey: 1 });
  });

  it("saves the held, outward drag intensity when the touch is released", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(<FlavorWheelInput value={{}} onChange={onChange} />);
    const wheel = container.querySelector("svg")!;
    vi.spyOn(wheel, "getBoundingClientRect").mockReturnValue({
      bottom: 340,
      height: 340,
      left: 0,
      right: 340,
      top: 0,
      width: 340,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // Hold Sweet (lower-right), then drag out to its first descriptor at 3×.
    fireEvent.pointerDown(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    vi.advanceTimersByTime(220);
    fireEvent.pointerMove(wheel, { pointerType: "touch", pointerId: 1, clientX: 280, clientY: 280 });
    fireEvent.pointerUp(wheel, { pointerType: "touch", pointerId: 1, clientX: 280, clientY: 280 });

    expect(onChange).toHaveBeenCalledWith({ honey: 3 });
    vi.useRealTimers();
  });

  it("uses the release position when a touch moves directly outward", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(<FlavorWheelInput value={{}} onChange={onChange} />);
    const wheel = container.querySelector("svg")!;
    vi.spyOn(wheel, "getBoundingClientRect").mockReturnValue({
      bottom: 340,
      height: 340,
      left: 0,
      right: 340,
      top: 0,
      width: 340,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    vi.advanceTimersByTime(220);
    fireEvent.pointerUp(wheel, { pointerType: "touch", pointerId: 1, clientX: 280, clientY: 280 });

    expect(onChange).toHaveBeenCalledWith({ honey: 3 });
    vi.useRealTimers();
  });

  it("renders chips for selected tags and removes on tap", () => {
    render(<Harness initial={{ vanilla: 2, "green-apple": 1 }} />);
    const vanillaChip = screen.getByRole("button", { name: "Remove Vanilla" });
    expect(vanillaChip).toHaveTextContent("Vanilla ××");
    expect(screen.getByRole("button", { name: "Remove Green apple" })).toHaveTextContent(
      "Green apple ×",
    );

    fireEvent.click(vanillaChip);
    expect(screen.queryByRole("button", { name: "Remove Vanilla" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Green apple" })).toBeInTheDocument();
  });
});
