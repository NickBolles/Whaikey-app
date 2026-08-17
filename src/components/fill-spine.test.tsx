// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FillSpine, spineTone } from "./fill-spine";

afterEach(cleanup);

function fillHeight(level: number | null): string {
  render(<FillSpine level={level} />);
  const height = screen.getByTestId("fill-spine-fill").style.height;
  cleanup();
  return height;
}

describe("FillSpine", () => {
  it("fills from the bottom in proportion to the level", () => {
    expect(fillHeight(72)).toBe("72%");
    expect(fillHeight(100)).toBe("100%");
  });

  it("clamps out-of-range levels and treats null as empty", () => {
    expect(fillHeight(150)).toBe("100%");
    expect(fillHeight(-5)).toBe("0%");
    expect(fillHeight(null)).toBe("0%");
  });

  it("exposes the level via an accessible label", () => {
    render(<FillSpine level={30} />);
    expect(screen.getByRole("img", { name: "30% full" })).toBeInTheDocument();
  });

  it("uses the given tone for the fill", () => {
    render(<FillSpine level={50} tone="#7a4a22" />);
    expect(screen.getByTestId("fill-spine-fill").style.backgroundColor).toBe("rgb(122, 74, 34)");
  });
});

describe("spineTone", () => {
  it("is deterministic per seed", () => {
    expect(spineTone("eagle-rare-10")).toBe(spineTone("eagle-rare-10"));
  });

  it("returns a hex brown for any seed", () => {
    expect(spineTone("")).toMatch(/^#[0-9a-f]{6}$/);
    expect(spineTone("lagavulin-16")).toMatch(/^#[0-9a-f]{6}$/);
  });
});
