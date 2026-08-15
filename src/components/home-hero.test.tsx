// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HomeHero } from "@/components/home-hero";

afterEach(cleanup);

describe("HomeHero", () => {
  it("offers pour + add-bottle actions with a shelf summary when the bar is stocked", () => {
    render(<HomeHero bottleCount={7} pourCount={12} />);

    expect(screen.getByRole("heading", { name: "Your next pour" })).toBeInTheDocument();
    expect(screen.getByText("7 bottles on your shelf · 12 pours logged")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Log a pour/ })).toHaveAttribute("href", "/pour");
    expect(screen.getByRole("link", { name: /Add a bottle/ })).toHaveAttribute("href", "/search");
    // The empty-bar variant must not leak in.
    expect(screen.queryByText("Stock your bar")).not.toBeInTheDocument();
  });

  it("singularizes the summary counts", () => {
    render(<HomeHero bottleCount={1} pourCount={1} />);
    expect(screen.getByText("1 bottle on your shelf · 1 pour logged")).toBeInTheDocument();
  });

  it("switches to the stock-your-bar variant when the user owns no bottles", () => {
    render(<HomeHero bottleCount={0} pourCount={0} />);

    expect(screen.getByRole("heading", { name: "Stock your bar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Scan a bottle/ })).toHaveAttribute("href", "/scan");
    expect(screen.getByRole("link", { name: /Search/ })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("link", { name: "Take the tour" })).toHaveAttribute("href", "/welcome");
    expect(screen.queryByRole("link", { name: /Log a pour/ })).not.toBeInTheDocument();
  });
});
