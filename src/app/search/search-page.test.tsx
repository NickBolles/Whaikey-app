// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SearchPage from "./page";

/**
 * Review PLAN-A1: "No bottles found" was the end of the road. With 269 seeded
 * bottles, "not in there" is an ordinary answer, so the ordinary answer needs
 * somewhere to go — and it has to carry what the user already typed.
 *
 * Owner direction 2026-10-26: the same action rides WITH the results too —
 * at the top and the end of the list — because the closest matches are often
 * not the bottle in your hand.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockSearch(results: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results })));
}

const EAGLE = { id: "b1", name: "Eagle Rare 10", category: "bourbon", distillery: null, country: null, region: null, ageYears: 10, abv: 45, avgPrice: 40, flavorProfile: null };

describe("search empty state", () => {
  it("offers the submission path, pre-filled with the query", async () => {
    mockSearch([]);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByLabelText(/search bottles/i), "barrell dovetail");

    const link = await screen.findByRole("link", { name: /add this bottle/i });
    expect(link).toHaveAttribute("href", "/bottles/new?source=search&name=barrell%20dovetail");
    expect(screen.getByText(/Add “barrell dovetail”/)).toBeInTheDocument();
  });

  it("still offers it with nothing typed, without inventing a name", async () => {
    mockSearch([]);
    render(<SearchPage />);
    const link = await screen.findByRole("link", { name: /add a bottle/i });
    expect(link).toHaveAttribute("href", "/bottles/new?source=search");
  });
});

describe("Add this bottle alongside results", () => {
  it("puts a prefilled Add action at the top and at the end of the results", async () => {
    mockSearch([EAGLE]);
    const user = userEvent.setup();
    render(<SearchPage />);
    await user.type(screen.getByLabelText(/search bottles/i), "eagle rare 12");

    const top = await screen.findByRole("region", { name: "Add this bottle" });
    const topLink = within(top).getByRole("link", { name: /add this bottle/i });
    expect(topLink).toHaveAttribute("href", "/bottles/new?source=search&name=eagle%20rare%2012");

    const endLink = await screen.findByRole("link", { name: "Add “eagle rare 12”" });
    expect(endLink).toHaveAttribute("href", "/bottles/new?source=search&name=eagle%20rare%2012");

    // Top block precedes the results, the closing button follows them.
    const result = await screen.findByText("Eagle Rare 10");
    expect(top.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(result.compareDocumentPosition(endLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("1 close match")).toBeInTheDocument();
  });

  it("stays out of the way while browsing popular bottles (nothing typed)", async () => {
    mockSearch([EAGLE]);
    render(<SearchPage />);
    expect(await screen.findByText("Eagle Rare 10")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /add this bottle/i })).toBeNull();
  });
});
