// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BottleListRow } from "./bottle-list-row";

afterEach(cleanup);

describe("BottleListRow", () => {
  it("is a single link to the bottle with name, score, meta and remaining", () => {
    render(
      <BottleListRow
        href="/bottles/lagavulin-16"
        name="Lagavulin 16"
        score={4.5}
        meta="Islay · 43%"
        metaRight="72% left"
        spine={{ level: 72, bottleId: "lagavulin-16" }}
        flavorTags={{ campfire: 3, brine: 2, toffee: 1 }}
      />,
    );
    const row = screen.getByRole("link");
    expect(row).toHaveAttribute("href", "/bottles/lagavulin-16");
    expect(row).toHaveTextContent("Lagavulin 16");
    expect(row).toHaveTextContent("4.5");
    expect(row).toHaveTextContent("Islay · 43%");
    expect(row).toHaveTextContent("72% left");
    expect(screen.getByRole("img", { name: "72% full" })).toBeInTheDocument();
  });

  it("shows at most the top 3 of your own flavors, by intensity", () => {
    render(
      <BottleListRow
        href="/bottles/x"
        name="X"
        flavorTags={{ vanilla: 1, campfire: 3, brine: 2, toffee: 2, oak: 1 }}
      />,
    );
    const chips = screen.getAllByTestId("flavor-chip");
    // campfire first on intensity; toffee (Sweet) precedes brine (Peaty) on the wheel
    expect(chips.map((c) => c.textContent)).toEqual(["Campfire smoke", "Toffee", "Brine / seaweed"]);
  });

  it("never renders placeholder chips, a spine, or a score it doesn't have", () => {
    render(<BottleListRow href="/bottles/x" name="X" />);
    expect(screen.queryByTestId("flavor-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fill-spine")).not.toBeInTheDocument();
    expect(screen.getByRole("link").textContent).toBe("X");
  });

  it("shows the pour count and the rating range when pours disagree", () => {
    render(
      <BottleListRow
        href="/bottles/x"
        name="X"
        score={4.0}
        pours={{ count: 3, ratingMin: 3.5, ratingMax: 4.5 }}
      />,
    );
    const row = screen.getByRole("link");
    expect(row).toHaveTextContent("4.0");
    expect(row).toHaveTextContent("3 pours");
    expect(row).toHaveTextContent("3.5–4.5");
  });

  it("shows no range when every rated pour agrees, and singularises one pour", () => {
    render(
      <BottleListRow
        href="/bottles/x"
        name="X"
        score={4.5}
        pours={{ count: 1, ratingMin: 4.5, ratingMax: 4.5 }}
      />,
    );
    const row = screen.getByRole("link");
    expect(row).toHaveTextContent("1 pour");
    expect(row).not.toHaveTextContent("–");
  });

  it("counts unrated pours without inventing a score or a range", () => {
    render(<BottleListRow href="/bottles/x" name="X" pours={{ count: 2 }} />);
    const row = screen.getByRole("link");
    expect(row).toHaveTextContent("2 pours");
    expect(row).not.toHaveTextContent("–");
    expect(row.textContent).not.toMatch(/\d\.\d/);
  });
});
