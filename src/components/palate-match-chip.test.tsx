// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PalateMatchChip } from "./palate-match-chip";

afterEach(cleanup);

describe("PalateMatchChip", () => {
  it("states the match as a percentage of shared taste", () => {
    render(<PalateMatchChip matchPercent={87} />);
    expect(screen.getByTestId("palate-match")).toHaveTextContent("87% palate match");
  });

  it("renders a zero match honestly rather than hiding it", () => {
    // Callers hide the chip when the match is unknown (null); an actual 0 is a
    // real finding about the pair and reads as one.
    render(<PalateMatchChip matchPercent={0} />);
    expect(screen.getByTestId("palate-match")).toHaveTextContent("0% palate match");
  });
});
