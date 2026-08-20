// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RatingSparkline } from "./rating-sparkline";

afterEach(cleanup);

describe("RatingSparkline", () => {
  it("names every rating in reading order for non-visual readers", () => {
    render(<RatingSparkline ratings={[3.5, 4, 4.5]} />);
    expect(screen.getByTestId("rating-sparkline")).toHaveAccessibleName(
      "Rating trend across 3 pours: 3.5, 4.0, 4.5",
    );
  });

  it("draws one dot per pour, the latest set apart from the rest", () => {
    render(<RatingSparkline ratings={[3.5, 4, 4.5]} />);
    const dots = screen.getByTestId("rating-sparkline").querySelectorAll("[data-dot]");
    expect(dots).toHaveLength(3);
    expect(dots[2].getAttribute("data-dot")).toBe("last");
    expect(dots[2].getAttribute("stroke")).toBe("var(--accent)");
    expect(dots[0].getAttribute("stroke")).toBe("var(--accent-deep)");
  });

  it("refuses to draw a trend from a single point", () => {
    const { container } = render(<RatingSparkline ratings={[4]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
