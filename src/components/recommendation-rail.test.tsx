// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { RecommendationRail, getTonightPourContext } from "@/components/recommendation-rail";
import type { Recommendation } from "@/lib/recommend";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetchOnce(recommendations: Recommendation[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ mode: "discovery", recommendations }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const REC: Recommendation = {
  bottleId: "b1",
  name: "Smoky Match",
  distillery: "Islay Distillers",
  category: "scotch-single-malt",
  region: "Islay",
  country: null,
  ageYears: 12,
  avgPrice: 65,
  matchPercent: 87,
  reason: "Leans into your taste for smoky and woody drams, in your usual $50–70 range.",
};

describe("getTonightPourContext", () => {
  it.each([
    [8, "For later today", "Your bar’s considered pick, ready when the moment is right."],
    [14, "This afternoon’s selection", "A personal pick from your bar, at your pace."],
    [19, "Tonight’s pour", "A personal pick from your bar for the evening."],
    [23, "Tonight’s selection", "A personal pick from your bar for a quieter moment."],
  ])("uses a personal time-of-day cue at %i:00", (hour, title, detail) => {
    expect(getTonightPourContext(hour)).toEqual({ title, detail });
  });
});

describe("RecommendationRail", () => {
  it("renders a card with name, match chip, reason, and bottle link", async () => {
    mockFetchOnce([REC]);
    render(<RecommendationRail mode="discovery" title="Bottles for you" />);

    await waitFor(() => expect(screen.getByText("Smoky Match")).toBeInTheDocument());
    expect(screen.getByText("87% match")).toBeInTheDocument();
    expect(screen.getByText(/smoky and woody drams/i)).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /Smoky Match/i });
    expect(link).toHaveAttribute("href", "/bottles/b1");
  });

  it("renders a 'Log a pour' link in tonight mode", async () => {
    mockFetchOnce([{ ...REC, fillLevel: 20, status: "open", userBottleId: "ub1" }]);
    render(<RecommendationRail mode="tonight" title="What to pour tonight" />);

    await waitFor(() => expect(screen.getByText("Smoky Match")).toBeInTheDocument());
    const pourLink = screen.getByRole("link", { name: /Log a pour/i });
    expect(pourLink).toHaveAttribute("href", "/pour?bottleId=b1");
  });

  it("renders the empty state when there are no recommendations", async () => {
    mockFetchOnce([]);
    render(<RecommendationRail mode="discovery" title="Bottles for you" />);

    await waitFor(() =>
      expect(screen.getByText(/learn your taste/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("Smoky Match")).not.toBeInTheDocument();
  });
});
