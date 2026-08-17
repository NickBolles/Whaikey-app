// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BottleComparison } from "@/lib/bottle-compare";
import { CompareClient } from "./compare-client";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function comparison(overrides: Partial<BottleComparison> = {}): BottleComparison {
  return {
    bottleId: "islay-16",
    bottleName: "Islay 16",
    viewerTags: { campfire: 3, brine: 1 },
    viewerPourId: "pour-1",
    friends: {
      count: 1,
      tags: { campfire: 2, peat: 2 },
      notes: [
        {
          pourId: "friend-pour",
          author: { handle: "sasha", displayName: "Sasha Glen", avatarUrl: null },
          rating: 4.5,
          createdAt: "2026-07-15T20:00:00Z",
          text: "Smoke first, then the sea.",
          flavorTags: { campfire: 2, peat: 2 },
        },
      ],
    },
    community: {
      count: 3,
      tags: { medicinal: 2.5, campfire: 1 },
    },
    professional: {
      tags: { peat: 3, campfire: 2, tar: 2 },
      producer: {
        sourceLabel: "Distillery tasting notes",
        sourceUrl: "https://example.com/notes",
        tags: { peat: 3, campfire: 2 },
      },
      critics: [
        {
          publication: "Whisky Review",
          score: "91",
          scoreScale: "/100",
          note: "Tar and iodine, a very long finish.",
          sourceUrl: "https://example.com/review",
          flavorTags: { tar: 2 },
        },
      ],
    },
    ...overrides,
  };
}

describe("CompareClient", () => {
  it("computes a different labelled match per source without refetching", () => {
    render(<CompareClient comparison={comparison()} />);

    // Friends is the default segment.
    const match = () => screen.getByTestId("match-percent").textContent;
    const friendsMatch = match();
    expect(friendsMatch).toMatch(/% match with friends$/);

    fireEvent.click(screen.getByRole("tab", { name: /Community · 3/ }));
    const communityMatch = match();
    expect(communityMatch).toMatch(/% match with the community$/);

    fireEvent.click(screen.getByRole("tab", { name: "Professional" }));
    const proMatch = match();
    expect(proMatch).toMatch(/% match with the pros$/);

    expect(new Set([friendsMatch, communityMatch, proMatch]).size).toBe(3);
  });

  it("keeps flavors only the reference logged, as a zero-width 'you' bar", () => {
    render(<CompareClient comparison={comparison()} />);
    // peat: friends logged it, the viewer didn't — the row still appears.
    expect(screen.getByLabelText("Earthy peat: you 0, them 2")).toBeInTheDocument();
  });

  it("shows the distillery card under every segment, with shared count and chips", () => {
    render(<CompareClient comparison={comparison()} />);
    for (const tabName of [/Community/, "Professional", /Friends/]) {
      fireEvent.click(screen.getByRole("tab", { name: tabName }));
      const card = screen.getByRole("region", { name: "Distillery note" });
      expect(card).toHaveTextContent("1 of 2 shared");
      expect(card).toHaveTextContent("Distillery tasting notes");
    }
    // campfire: you both got it (✓); peat: they got it, you didn't (+).
    const chips = screen.getAllByTestId("flavor-chip");
    expect(chips.some((c) => c.getAttribute("data-variant") === "confirmed")).toBe(true);
    expect(chips.some((c) => c.getAttribute("data-variant") === "suggested")).toBe(true);
  });

  it("adds a suggested flavor to your note on tap and re-computes inline", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pourId: "pour-1", flavorTags: { campfire: 3, brine: 1, peat: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CompareClient comparison={comparison()} />);

    const before = screen.getByTestId("match-percent").textContent;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add Earthy peat to your note" }));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bottles/islay-16/note-tags",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ leafId: "peat" }) }),
    );
    expect(screen.getByRole("region", { name: "Distillery note" })).toHaveTextContent("2 of 2 shared");
    expect(screen.getByTestId("match-percent").textContent).not.toBe(before);
  });

  it("shows the segment's prose cards: friends' notes, then critics under Professional", () => {
    render(<CompareClient comparison={comparison()} />);
    expect(screen.getByText("Smoke first, then the sea.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Professional" }));
    expect(screen.getByText("Whisky Review")).toBeInTheDocument();
    expect(screen.getByText(/Tar and iodine/)).toBeInTheDocument();
    // Every displayed critic note is verifiable at its source.
    expect(screen.getByRole("link", { name: "Read the review" })).toHaveAttribute(
      "href",
      "https://example.com/review",
    );
    expect(screen.queryByText("Smoke first, then the sea.")).not.toBeInTheDocument();
  });

  it("keeps the community segment anonymous — bars and a count, never a stranger's note", () => {
    render(<CompareClient comparison={comparison()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Community · 3/ }));

    // The aggregate still says something: bars, a match, and how it is built.
    expect(screen.getByLabelText("Agreement bars")).toBeInTheDocument();
    expect(screen.getByText(/anonymous by design/)).toBeInTheDocument();
    // No attributed prose from people the viewer does not follow.
    expect(screen.queryByLabelText("Community notes")).not.toBeInTheDocument();
    expect(screen.queryByText("Smoke first, then the sea.")).not.toBeInTheDocument();
  });

  it("gives an empty segment a one-line state instead of hiding it", () => {
    render(
      <CompareClient
        comparison={comparison({ friends: { count: 0, tags: {}, notes: [] } })}
      />,
    );
    expect(
      screen.getByText(/None of your friends have logged this bottle yet/),
    ).toBeInTheDocument();
    // The switch itself stays: absence is informative.
    expect(screen.getByRole("tab", { name: /Friends · 0/ })).toBeInTheDocument();
  });
});
