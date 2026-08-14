// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WishlistCta } from "./wishlist-cta";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WishlistCta (US-3)", () => {
  it("adds the bottle to the wishlist in one tap", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    render(<WishlistCta bottleId="b1" initialRelationship={null} />);
    await userEvent.click(screen.getByRole("button", { name: /add to wishlist/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user-bottles",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ bottleId: "b1", relationship: "wishlist" }) }),
    );
    await waitFor(() => expect(screen.getByText("Already on your wishlist")).toBeInTheDocument());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the existing relationship state instead of the CTA", () => {
    render(<WishlistCta bottleId="b1" initialRelationship="tried" />);
    expect(screen.getByText("You've already tried this one")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the CTA and surfaces an error when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    render(<WishlistCta bottleId="b1" initialRelationship={null} />);
    await userEvent.click(screen.getByRole("button", { name: /add to wishlist/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /add to wishlist/i })).toBeInTheDocument();
  });
});
