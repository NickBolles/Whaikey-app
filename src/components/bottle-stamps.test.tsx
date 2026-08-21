// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BottleStamps } from "./bottle-stamps";

afterEach(cleanup);

/** Frame silhouettes, per src/components/passport-badge.tsx. */
function families(container: HTMLElement): string[] {
  return [...container.querySelectorAll("svg")].map((svg) => {
    if (svg.querySelector("path[d^='M36 4']")) return "country";
    if (svg.querySelector("circle[r='31']")) return "region";
    return "style";
  });
}

describe("BottleStamps", () => {
  it("stamps country, region and style in coarse-to-fine order", () => {
    const { container } = render(
      <BottleStamps category="scotch-single-malt" region="Islay" country="Scotland" />,
    );
    expect(families(container)).toEqual(["country", "region", "style"]);
  });

  it("skips the region a blend has no value for", () => {
    const { container } = render(
      <BottleStamps category="scotch-blended" region={null} country="Scotland" />,
    );
    expect(families(container)).toEqual(["country", "style"]);
  });

  it("strikes the unstruck die — no tier numeral, whatever the size", () => {
    const { container } = render(
      <BottleStamps category="bourbon" region="Kentucky" country="USA" size={64} />,
    );
    // A tiered crest at 64px flies its numeral; a bottle's stamps never do,
    // because a card knows nothing about who is looking at it.
    expect(container.textContent).toBe("");
  });

  it("hides the run from assistive tech — the card's text already says it", () => {
    const { container } = render(<BottleStamps category="rye" country="USA" />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders nothing without a category or an origin", () => {
    const { container } = render(<BottleStamps category="" region={null} country={null} />);
    expect(container.innerHTML).toBe("");
  });
});
