// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PullQuote, isQuotable, PULL_QUOTE_MIN_CHARS } from "@/components/pull-quote";

afterEach(cleanup);

describe("PullQuote", () => {
  it("renders the note as a blockquote with kicker and byline", () => {
    render(<PullQuote text="Canned peach and incense." kicker="Tasting note" byline="Yamazaki 12" />);
    const fig = screen.getByTestId("pull-quote");
    expect(fig.tagName).toBe("FIGURE");
    expect(fig).toHaveClass("pull-quote");
    expect(fig).not.toHaveClass("pull-quote-center");
    expect(fig.querySelector("blockquote")).toHaveTextContent("Canned peach and incense.");
    expect(screen.getByText("Tasting note")).toHaveClass("kicker");
    expect(screen.getByText("Yamazaki 12")).toBeInTheDocument();
  });

  it("centres between double rules on the bottle page", () => {
    render(<PullQuote variant="center" text="Bonfire on the beach, then raisins." />);
    expect(screen.getByTestId("pull-quote")).toHaveClass("pull-quote-center");
  });
});

describe("isQuotable", () => {
  it("needs a real sentence, not two words", () => {
    expect(isQuotable(null)).toBe(false);
    expect(isQuotable(undefined)).toBe(false);
    expect(isQuotable("Smoky, sweet.")).toBe(false);
    expect(isQuotable("x".repeat(PULL_QUOTE_MIN_CHARS))).toBe(true);
    expect(isQuotable(`  ${"x".repeat(PULL_QUOTE_MIN_CHARS - 1)}  `)).toBe(false);
  });
});
