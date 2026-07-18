// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BottleCard } from "@/components/bottle-card";

afterEach(cleanup);

const bottle = {
  id: "b1",
  name: "Eagle Rare 10 Year",
  category: "bourbon",
  distillery: "Buffalo Trace",
  ageYears: 10,
  abv: 45,
  avgPrice: 49.99,
};

describe("BottleCard", () => {
  it("shows name, distillery, category chip, specs and price, linking to detail", () => {
    render(<BottleCard bottle={bottle} />);
    expect(screen.getByText("Eagle Rare 10 Year")).toBeInTheDocument();
    expect(screen.getByText("Buffalo Trace")).toBeInTheDocument();
    expect(screen.getByText("Bourbon")).toBeInTheDocument();
    expect(screen.getByText("10 yr · 45% ABV")).toBeInTheDocument();
    expect(screen.getByText("$50")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/bottles/b1");
  });

  it("omits distillery and price when absent", () => {
    render(
      <BottleCard
        bottle={{ ...bottle, id: "b2", distillery: null, avgPrice: null, ageYears: null }}
      />,
    );
    expect(screen.queryByText("Buffalo Trace")).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getByText("45% ABV")).toBeInTheDocument();
  });
});
