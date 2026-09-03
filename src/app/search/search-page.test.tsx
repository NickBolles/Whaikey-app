// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchPage from "./page";

/**
 * Review PLAN-A1: "No bottles found" was the end of the road. With 269 seeded
 * bottles, "not in there" is an ordinary answer, so the ordinary answer needs
 * somewhere to go — and it has to carry what the user already typed.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockSearch(results: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results })));
}

describe("search empty state", () => {
  it("offers the submission path, pre-filled with the query", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByLabelText(/search bottles/i), "barrell dovetail");

    const link = await screen.findByRole("link", { name: /add it yourself/i });
    expect(link).toHaveAttribute(
      "href",
      "/bottles/new?source=search&name=barrell%20dovetail",
    );
  });

  it("still offers it with nothing typed, without inventing a name", async () => {
    mockSearch([]);
    render(<SearchPage />);
    const link = await screen.findByRole("link", { name: /add it yourself/i });
    expect(link).toHaveAttribute("href", "/bottles/new?source=search");
  });

  it("does not offer it when the catalog had an answer", async () => {
    mockSearch([{ id: "b1", name: "Eagle Rare 10", category: "bourbon", distillery: null, country: null, region: null, ageYears: 10, abv: 45, avgPrice: 40, flavorProfile: null }]);
    render(<SearchPage />);
    expect(await screen.findByText("Eagle Rare 10")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /add it yourself/i })).toBeNull();
  });
});
