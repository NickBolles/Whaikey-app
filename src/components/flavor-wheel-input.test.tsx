// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const { haptic } = vi.hoisted(() => ({ haptic: vi.fn() }));
vi.mock("@/lib/native/haptics", () => ({ haptic }));
import { FlavorWheelInput } from "@/components/flavor-wheel-input";
import { WHEEL_HOLD_MS } from "@/components/wheel-gesture";

/** Pin the wheel's box so client coordinates map onto its 340×340 viewBox. */
function stubWheelBox(wheel: SVGSVGElement) {
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
}

afterEach(() => {
  cleanup();
  haptic.mockClear();
});

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

  it("adds progressively stronger haptics as a flavor rating cycles upward", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Sweet" }));
    const vanilla = () => screen.getByRole("button", { name: /^Vanilla(?:, intensity \d)?$/ });

    fireEvent.click(vanilla());
    fireEvent.click(vanilla());
    fireEvent.click(vanilla());

    expect(haptic.mock.calls).toEqual([["intensity-1"], ["intensity-2"], ["intensity-3"]]);
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
    stubWheelBox(wheel);

    // Hold Sweet (lower-right), then deliberately sweep sideways and outward to a descriptor at 3×.
    fireEvent.pointerDown(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    act(() => {
      vi.advanceTimersByTime(WHEEL_HOLD_MS);
    });
    fireEvent.pointerMove(wheel, { pointerType: "touch", pointerId: 1, clientX: 286, clientY: 274 });
    fireEvent.pointerUp(wheel, { pointerType: "touch", pointerId: 1, clientX: 286, clientY: 274 });

    expect(onChange).toHaveBeenCalledWith({ toffee: 3 });
    expect(haptic).toHaveBeenCalledWith("lock");
    expect(haptic).toHaveBeenCalledWith("category");
    expect(haptic).toHaveBeenCalledWith("intensity-3");
    expect(haptic).toHaveBeenCalledWith("success");
    vi.useRealTimers();
  });

  it("shows hold progress and a ready cue before a sweep is activated", () => {
    vi.useFakeTimers();
    const { container } = render(<FlavorWheelInput value={{}} onChange={vi.fn()} />);
    const wheel = container.querySelector("svg")!;

    fireEvent.pointerDown(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    expect(screen.getByText("hold to taste")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(WHEEL_HOLD_MS);
    });
    expect(screen.getByText("sweep to taste")).toBeInTheDocument();

    fireEvent.pointerUp(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    expect(screen.queryByText("sweep to taste")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("saves a straight vertical sweep, the shape of reaching the flavors above and below", () => {
    // The reason the gesture felt broken: sweeping out to a descriptor is a
    // radial move, so for half the wheel it is a vertical drag — the exact
    // motion a page scroll also is. Once the hold lands, the wheel owns it.
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(<FlavorWheelInput value={{}} onChange={onChange} />);
    const wheel = container.querySelector("svg")!;
    stubWheelBox(wheel);

    fireEvent.pointerDown(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    act(() => {
      vi.advanceTimersByTime(WHEEL_HOLD_MS);
    });
    fireEvent.pointerMove(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 330 });
    fireEvent.pointerUp(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 330 });

    expect(onChange).toHaveBeenCalledWith({ honey: 3 });
    vi.useRealTimers();
  });

  it("gives the touch back to the page when the finger moves before the hold lands", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(<FlavorWheelInput value={{}} onChange={onChange} />);
    const wheel = container.querySelector("svg")!;
    stubWheelBox(wheel);

    fireEvent.pointerDown(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    expect(screen.getByText("hold to taste")).toBeInTheDocument();
    // A scroll: moving before the hold completes drops the wheel's claim, cue and all.
    fireEvent.pointerMove(wheel, { pointerType: "touch", pointerId: 1, clientX: 272, clientY: 210 });
    expect(screen.queryByText("hold to taste")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(WHEEL_HOLD_MS);
    });
    fireEvent.pointerMove(wheel, { pointerType: "touch", pointerId: 1, clientX: 272, clientY: 140 });
    fireEvent.pointerUp(wheel, { pointerType: "touch", pointerId: 1, clientX: 272, clientY: 140 });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("sweep to taste")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("only blocks the page scroll once the hold has claimed the touch", () => {
    vi.useFakeTimers();
    const { container } = render(<FlavorWheelInput value={{}} onChange={vi.fn()} />);
    const wheel = container.querySelector("svg")!;
    stubWheelBox(wheel);

    fireEvent.pointerDown(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    const duringHold = fireEvent.touchMove(wheel, { touches: [{ clientX: 270, clientY: 250 }] });
    expect(duringHold).toBe(true); // not prevented: the page is still free to scroll

    act(() => {
      vi.advanceTimersByTime(WHEEL_HOLD_MS);
    });
    const afterHold = fireEvent.touchMove(wheel, { touches: [{ clientX: 270, clientY: 250 }] });
    expect(afterHold).toBe(false); // prevented: the sweep owns the touch

    fireEvent.pointerUp(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    const afterRelease = fireEvent.touchMove(wheel, { touches: [{ clientX: 270, clientY: 250 }] });
    expect(afterRelease).toBe(true);
    vi.useRealTimers();
  });

  it("commits nothing when a hold is released without a sweep", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container } = render(<FlavorWheelInput value={{}} onChange={onChange} />);
    const wheel = container.querySelector("svg")!;
    stubWheelBox(wheel);

    fireEvent.pointerDown(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });
    act(() => {
      vi.advanceTimersByTime(WHEEL_HOLD_MS);
    });
    fireEvent.pointerUp(wheel, { pointerType: "touch", pointerId: 1, clientX: 270, clientY: 270 });

    expect(onChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("renders chips for selected tags and removes on tap", () => {
    render(<Harness initial={{ vanilla: 2, "green-apple": 1 }} />);
    const vanillaChip = screen.getByRole("button", { name: "Remove Vanilla" });
    // Intensity reads as a 3-dot meter, not repeated glyphs — the label carries
    // the level so it can't be confused with the ✕ remove control beside it.
    expect(vanillaChip).toHaveTextContent("Vanilla");
    expect(within(vanillaChip).getByRole("img", { name: "intensity 2 of 3" })).toBeInTheDocument();
    const appleChip = screen.getByRole("button", { name: "Remove Green apple" });
    expect(appleChip).toHaveTextContent("Green apple");
    expect(within(appleChip).getByRole("img", { name: "intensity 1 of 3" })).toBeInTheDocument();

    fireEvent.click(vanillaChip);
    expect(screen.queryByRole("button", { name: "Remove Vanilla" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Green apple" })).toBeInTheDocument();
  });
});
