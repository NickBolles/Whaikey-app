// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SameDram, type SameDramFriendNote } from "@/components/same-dram";

afterEach(cleanup);

function friend(over: Partial<SameDramFriendNote> = {}): SameDramFriendNote {
  return {
    author: over.author ?? { userId: "u2", handle: "sarah", displayName: "Sarah", avatarUrl: null },
    pourId: over.pourId ?? "pour-2",
    rating: over.rating ?? 4,
    createdAt: over.createdAt ?? "2026-08-01T00:00:00.000Z",
    flavorTags: over.flavorTags ?? { clove: 3 },
  };
}

describe("SameDram", () => {
  it("renders nothing when there are no friend notes and the viewer has none either", () => {
    const { container } = render(<SameDram viewerTags={null} producer={null} friends={[]} hasViewerNotes={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the muted invite line when the viewer has notes but no friends have tasted it", () => {
    render(<SameDram viewerTags={{ vanilla: 2 }} producer={null} friends={[]} hasViewerNotes={true} />);
    expect(screen.getByText(/none of your friends have tasted it yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Find friends" })).toHaveAttribute("href", "/friends");
  });

  it("renders the You / Label / Friends three-way view with chips", () => {
    render(
      <SameDram
        viewerTags={{ vanilla: 2, oak: 1 }}
        producer={{ tags: { vanilla: 3, peat: 2 }, sourceLabel: "Distillery notes", sourceUrl: "https://example.com" }}
        friends={[friend()]}
        hasViewerNotes={true}
      />,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("The label")).toBeInTheDocument();
    expect(screen.getByText("Friends")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Distillery notes" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByRole("link", { name: "@sarah" })).toHaveAttribute("href", "/u/sarah");
    // "Vanilla" shared between You and Label renders in both columns.
    expect(screen.getAllByText("Vanilla").length).toBeGreaterThanOrEqual(2);
  });

  it("renders a payoff line only for a clean same-wedge, different-leaf pair", () => {
    render(
      <SameDram
        viewerTags={{ cinnamon: 2 }}
        producer={null}
        friends={[friend({ flavorTags: { clove: 3 } })]}
        hasViewerNotes={true}
      />,
    );
    expect(screen.getByText(/writes clove, you write cinnamon/i)).toBeInTheDocument();
  });

  it("skips the payoff line when the friend named the same leaf as the viewer", () => {
    render(
      <SameDram
        viewerTags={{ clove: 2 }}
        producer={null}
        friends={[friend({ flavorTags: { clove: 3 } })]}
        hasViewerNotes={true}
      />,
    );
    expect(screen.queryByText(/writes/i)).not.toBeInTheDocument();
  });

  it("shows a contested hint only with 2+ friends split on a descriptor", () => {
    render(
      <SameDram
        viewerTags={null}
        producer={null}
        friends={[friend({ author: { userId: "u2", handle: "sarah", displayName: "Sarah", avatarUrl: null }, flavorTags: { peat: 3 } }), friend({ author: { userId: "u3", handle: "nick", displayName: "Nick", avatarUrl: null }, flavorTags: { vanilla: 2 } })]}
        hasViewerNotes={false}
      />,
    );
    expect(screen.getByText(/friends split on/i)).toBeInTheDocument();
  });

  it("omits the contested hint with a single friend", () => {
    render(<SameDram viewerTags={null} producer={null} friends={[friend()]} hasViewerNotes={false} />);
    expect(screen.queryByText(/friends split on/i)).not.toBeInTheDocument();
  });
});
