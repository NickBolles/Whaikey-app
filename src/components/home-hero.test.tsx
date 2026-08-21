// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { HomeHero } from "@/components/home-hero";
import { getTonightPourContext } from "@/components/recommendation-rail";
import type { Recommendation } from "@/lib/recommend";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetchOnce(recommendations: Recommendation[]) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ mode: "tonight", recommendations }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

const PICK: Recommendation = {
  bottleId: "b1",
  name: "Smoky Match",
  distillery: "Islay Distillers",
  category: "scotch-single-malt",
  region: "Islay",
  country: null,
  ageYears: 12,
  avgPrice: 65,
  matchPercent: 87,
  reason: "Leans into your taste for smoky and woody drams.",
  fillLevel: 40,
  status: "open",
  userBottleId: "ub1",
};

describe("HomeHero", () => {
  it("renders tonight's pick as the primary action, with match chip and no prices", async () => {
    const fetchSpy = mockFetchOnce([PICK]);
    render(<HomeHero bottleCount={7} pourCount={12} />);

    await waitFor(() => expect(screen.getByText("Smoky Match")).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/recommendations?mode=tonight",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    // Time-aware heading comes from the rail's shared context helper.
    const { title, detail } = getTonightPourContext(new Date().getHours());
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    // The heading alone carries the time-of-day cue now: the mood line under
    // it made a single suggestion outweigh the month above it.
    expect(screen.queryByText(detail)).not.toBeInTheDocument();

    expect(screen.getByText("87% match")).toBeInTheDocument();
    expect(screen.getByText(/Islay Distillers/)).toBeInTheDocument();
    expect(screen.getByText(/smoky and woody drams/i)).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /Log this pour/ })).toHaveAttribute(
      "href",
      "/pour?bottleId=b1",
    );
    expect(screen.getByRole("link", { name: "Pick another" })).toHaveAttribute("href", "/pour");

    // The hero is about the pour, not money.
    expect(screen.queryByText(/\$\s?65/)).not.toBeInTheDocument();
    // The fallback variants must not leak in.
    expect(screen.queryByText("Your next pour")).not.toBeInTheDocument();
    expect(screen.queryByText("Stock your bar")).not.toBeInTheDocument();
  });

  it("shows the shared loading copy while the pick is being fetched", () => {
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));
    render(<HomeHero bottleCount={7} pourCount={12} />);

    // Exact copy matters: the e2e settle() helper waits for this text.
    expect(screen.getByRole("status")).toHaveTextContent("Finding bottles…");
  });

  it("falls back to manual log/add actions when no recommendation is available", async () => {
    mockFetchOnce([]);
    render(<HomeHero bottleCount={7} pourCount={12} />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Your next pour" })).toBeInTheDocument(),
    );
    expect(screen.getByText("7 bottles on your shelf · 12 pours logged")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Log a pour/ })).toHaveAttribute("href", "/pour");
    expect(screen.getByRole("link", { name: /Add a bottle/ })).toHaveAttribute("href", "/search");
    expect(screen.queryByRole("link", { name: /Log this pour/ })).not.toBeInTheDocument();
  });

  it("falls back to manual actions when the recommendation fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    render(<HomeHero bottleCount={1} pourCount={1} />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Your next pour" })).toBeInTheDocument(),
    );
    expect(screen.getByText("1 bottle on your shelf · 1 pour logged")).toBeInTheDocument();
  });

  it("switches to the stock-your-bar variant, without fetching, when the user owns no bottles", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<HomeHero bottleCount={0} pourCount={0} />);

    expect(screen.getByRole("heading", { name: "Stock your bar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Scan a bottle/ })).toHaveAttribute("href", "/scan");
    expect(screen.getByRole("link", { name: /Search/ })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("link", { name: "Take the tour" })).toHaveAttribute("href", "/welcome");
    expect(screen.queryByRole("link", { name: /Log a pour/ })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
