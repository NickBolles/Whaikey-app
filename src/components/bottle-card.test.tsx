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
  country: "USA",
  region: "Kentucky",
  ageYears: 10,
  abv: 45,
  avgPrice: 49.99,
};

describe("BottleCard", () => {
  it("shows name, distillery, category chip, specs and price, linking to detail", () => {
    render(<BottleCard bottle={bottle} />);
    expect(screen.getByText("Eagle Rare 10 Year")).toBeInTheDocument();
    // originLabel() prefers the region over the country (src/lib/origin.ts).
    expect(screen.getByText("Buffalo Trace · Kentucky")).toBeInTheDocument();
    expect(screen.getByText("Bourbon")).toBeInTheDocument();
    expect(screen.getByText("10 yr · 45% ABV")).toBeInTheDocument();
    expect(screen.getByText("$50")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/bottles/b1");
  });

  it("leads with the bottle's passport stamps, hidden from assistive tech", () => {
    const { container } = render(<BottleCard bottle={bottle} />);
    // Country, region, style — the origin is already spoken by the text, so
    // the crests are decoration (src/components/bottle-stamps.tsx).
    expect(container.querySelectorAll("[aria-hidden='true'] svg")).toHaveLength(3);
    expect(screen.getByRole("link")).toHaveAccessibleName(/Eagle Rare 10 Year/);
  });

  it("stacks the stamps on the card's edge, off the text lines they would wrap", () => {
    const { container } = render(<BottleCard bottle={bottle} />);
    // The identity line is the card's tightest — a long category plus specs
    // already fills it. The stamps stack outside the whole text column, so
    // nothing on it has to wrap or truncate to make room, and the leading
    // slot stays free for a bottle shot or a distillery mark.
    const link = screen.getByRole("link");
    const stamps = container.querySelector("[aria-hidden='true']");
    expect(stamps?.parentElement).toBe(link);
    expect(link.firstElementChild).not.toBe(stamps);
    expect(screen.getByText("Bourbon").closest("[aria-hidden='true']")).toBeNull();
  });

  it("omits distillery and price when absent", () => {
    render(
      <BottleCard
        bottle={{ ...bottle, id: "b2", distillery: null, avgPrice: null, ageYears: null }}
      />,
    );
    expect(screen.queryByText(/Buffalo Trace/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getByText("45% ABV")).toBeInTheDocument();
  });
});
