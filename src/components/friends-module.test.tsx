// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FriendsModule, type FriendFeedItem } from "@/components/friends-module";

afterEach(cleanup);

function item(over: Partial<FriendFeedItem> = {}): FriendFeedItem {
  return {
    pourId: over.pourId ?? "pour-1",
    bottleId: "bottle-1",
    bottleName: "Lagavulin 16",
    author: over.author ?? { userId: "u2", handle: "nick", displayName: "Nick", avatarUrl: null },
    rating: over.rating ?? 4.5,
    servingStyle: "neat",
    createdAt: over.createdAt ?? new Date(Date.now() - 2 * 86_400_000).toISOString(),
    nose: over.nose ?? null,
    palate: over.palate ?? null,
    finish: over.finish ?? null,
    freeform: over.freeform ?? "Campfire and iodine, but sweeter than I remembered.",
    flavorTags: over.flavorTags ?? { peat: 3, brine: 2, vanilla: 1 },
    cheersCount: over.cheersCount ?? 2,
    commentCount: over.commentCount ?? 1,
    viewerTags: over.viewerTags ?? null,
    viewerBottleRelationship: over.viewerBottleRelationship ?? null,
    palateMatchPercent: over.palateMatchPercent ?? null,
  };
}

describe("FriendsModule", () => {
  it("shows the invite card when the viewer has no profile or no follows", () => {
    render(<FriendsModule items={[]} hasProfile={false} hasFollows={false} />);
    expect(screen.getByText("Notes are better shared")).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: "Find friends" });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute("href", "/friends");
  });

  it("shows the quiet-week line when followed but nothing shared", () => {
    render(<FriendsModule items={[]} hasProfile={true} hasFollows={true} />);
    expect(screen.getByText("Quiet week — nothing shared yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", "/friends");
  });

  it("renders the comparison line + Compare notes CTA when the viewer tasted the bottle too", () => {
    render(
      <FriendsModule
        items={[item({ viewerTags: { peat: 2, brine: 1, smoked: 3 } })]}
        hasProfile={true}
        hasFollows={true}
      />,
    );
    expect(screen.getByText(/you agreed on/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Compare notes →" })).toHaveAttribute("href", "/notes/pour-1");
  });

  it("renders discovery framing when the viewer has no notes on the bottle", () => {
    render(<FriendsModule items={[item({ viewerTags: null })]} hasProfile={true} hasFollows={true} />);
    expect(screen.getByText("New to you — see what they thought.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See the note →" })).toHaveAttribute("href", "/notes/pour-1");
  });

  it("says On your wishlist when the viewer wishlisted the bottle", () => {
    render(
      <FriendsModule
        items={[item({ viewerTags: null, viewerBottleRelationship: "wishlist" })]}
        hasProfile={true}
        hasFollows={true}
      />,
    );
    expect(screen.getByText("On your wishlist.")).toBeInTheDocument();
  });

  it("renders author, bottle link, rating and cheers/comment counts", () => {
    render(<FriendsModule items={[item()]} hasProfile={true} hasFollows={true} />);
    expect(screen.getByRole("link", { name: "@nick" })).toHaveAttribute("href", "/u/nick");
    expect(screen.getByRole("link", { name: "Lagavulin 16" })).toHaveAttribute("href", "/bottles/bottle-1");
    expect(screen.getByText("4.5")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});

describe("FriendsModule — taste twins (US-16)", () => {
  it("marks a note from someone who tastes like you", () => {
    render(
      <FriendsModule
        items={[item({ palateMatchPercent: 87 })]}
        hasProfile
        hasFollows
      />,
    );
    expect(screen.getByTestId("palate-match")).toHaveTextContent("87% palate match");
  });

  it("says nothing when the match can't be computed yet", () => {
    render(<FriendsModule items={[item({ palateMatchPercent: null })]} hasProfile hasFollows />);
    expect(screen.queryByTestId("palate-match")).not.toBeInTheDocument();
  });
});
