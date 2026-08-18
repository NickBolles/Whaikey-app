// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlavorChip, leafColor } from "./flavor-chip";

afterEach(cleanup);

describe("leafColor", () => {
  it("gives every taxonomy leaf its own non-grey color", () => {
    expect(leafColor("vanilla")).toMatch(/^#[0-9a-f]{6}$/);
    expect(leafColor("campfire")).toMatch(/^#[0-9a-f]{6}$/);
    expect(leafColor("vanilla")).not.toBe(leafColor("campfire"));
  });

  it("grades siblings within a family to distinct shades", () => {
    expect(leafColor("vanilla")).not.toBe(leafColor("caramel"));
  });

  it("falls back to the muted token for unknown ids", () => {
    expect(leafColor("not-a-flavor")).toBe("var(--muted)");
  });
});

describe("FlavorChip", () => {
  it("renders the taxonomy label in the leaf's own color", () => {
    render(<FlavorChip leafId="toffee" />);
    const chip = screen.getByTestId("flavor-chip");
    expect(chip).toHaveTextContent("Toffee");
    expect(chip.style.backgroundColor).not.toBe("");
  });

  it("shows intensity as a 3-dot meter, filled to the level", () => {
    render(<FlavorChip leafId="brine" intensity={3} />);
    expect(screen.getByRole("img", { name: "intensity 3 of 3" })).toBeInTheDocument();
  });

  it("keeps all three dots at a lower intensity, so chip widths stay even", () => {
    // The unearned dots are dimmed, not dropped: a row of chips at mixed
    // intensities holds its rhythm, and nothing resizes when a level changes.
    render(<FlavorChip leafId="brine" intensity={1} />);
    const meter = screen.getByRole("img", { name: "intensity 1 of 3" });
    expect(meter).toHaveTextContent("●●●");
    expect(meter.querySelectorAll("span")).toHaveLength(3);
  });

  it("prefixes confirmed chips with ✓ and suggested chips with +", () => {
    render(<FlavorChip leafId="oak" variant="confirmed" />);
    expect(screen.getByTestId("flavor-chip")).toHaveTextContent("✓Oak");
    cleanup();
    render(<FlavorChip leafId="oak" variant="suggested" />);
    expect(screen.getByTestId("flavor-chip")).toHaveTextContent("+Oak");
  });

  it("becomes a button when given onClick", async () => {
    const onClick = vi.fn();
    render(<FlavorChip leafId="honey" variant="suggested" onClick={onClick} aria-label="Add Honey" />);
    await userEvent.click(screen.getByRole("button", { name: "Add Honey" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is not interactive without onClick", () => {
    render(<FlavorChip leafId="honey" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
