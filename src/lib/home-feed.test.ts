import { describe, expect, it } from "vitest";
import {
  LATELY_PAGE,
  buildFriendRows,
  buildYouRows,
  friendRowHref,
  friendRowSummary,
  pageRows,
  parseLatelyTab,
  type FriendActivityInput,
} from "@/lib/home-feed";

const sasha = { userId: "u-sasha", handle: "sasha", displayName: "Sasha", avatarUrl: null };
const remy = { userId: "u-remy", handle: "remy", displayName: "Remy", avatarUrl: null };

function item(over: Partial<FriendActivityInput> & { pourId: string }): FriendActivityInput {
  return {
    bottleId: `b-${over.pourId}`,
    bottleName: `Bottle ${over.pourId}`,
    rating: 4,
    createdAt: "2026-10-30T12:00:00.000Z",
    visibility: "friends",
    author: sasha,
    ...over,
  };
}

describe("buildYouRows", () => {
  it("pins the badge first, then your tastings newest first", () => {
    const rows = buildYouRows(
      [
        { id: "p1", bottleId: "b1", bottleName: "Old", rating: null, createdAt: "2026-10-01T00:00:00.000Z" },
        { id: "p2", bottleId: "b2", bottleName: "New", rating: 4.5, createdAt: "2026-10-20T00:00:00.000Z" },
      ],
      { label: "Islay", tierLabel: "Silver II", detail: "3 distinct bottles met", href: "/passport/region/Islay", family: "region", value: "Islay", tier: 2 },
    );
    expect(rows.map((r) => r.key)).toEqual(["badge:region:Islay", "pour:p2", "pour:p1"]);
  });

  it("is empty with nothing tasted and no badge", () => {
    expect(buildYouRows([], null)).toEqual([]);
  });
});

describe("buildFriendRows", () => {
  it("collapses everything from the same friend into one row at their newest item", () => {
    const rows = buildFriendRows(
      [
        item({ pourId: "a", createdAt: "2026-10-28T00:00:00.000Z" }),
        item({ pourId: "b", author: remy, createdAt: "2026-10-29T00:00:00.000Z" }),
        item({ pourId: "c", createdAt: "2026-10-31T00:00:00.000Z" }),
      ],
      "viewer",
    );
    expect(rows.map((r) => r.author.handle)).toEqual(["sasha", "remy"]);
    expect(rows[0].items.map((i) => i.pourId)).toEqual(["c", "a"]);
    expect(rows[0].latestAt).toBe("2026-10-31T00:00:00.000Z");
  });

  it("never shows a private pour, even if one is passed in", () => {
    const rows = buildFriendRows(
      [item({ pourId: "secret", visibility: "private" }), item({ pourId: "shared", visibility: "followers" })],
      "viewer",
    );
    expect(rows.flatMap((r) => r.items.map((i) => i.pourId))).toEqual(["shared"]);
  });

  it("drops unknown visibility tiers and the viewer's own items", () => {
    const rows = buildFriendRows(
      [
        item({ pourId: "weird", visibility: "everyone-now" }),
        item({ pourId: "mine", author: { ...remy, userId: "viewer" } }),
        item({ pourId: "pub", visibility: "public" }),
      ],
      "viewer",
    );
    expect(rows.flatMap((r) => r.items.map((i) => i.pourId))).toEqual(["pub"]);
  });

  it("de-duplicates repeated pour ids", () => {
    const rows = buildFriendRows([item({ pourId: "a" }), item({ pourId: "a" })], "viewer");
    expect(rows[0].items).toHaveLength(1);
  });
});

describe("friend row copy and links", () => {
  it("one item reads as one line and opens the note", () => {
    const [row] = buildFriendRows([item({ pourId: "a", bottleName: "Lagavulin 16" })], "viewer");
    expect(friendRowSummary(row)).toBe("rated Lagavulin 16");
    expect(friendRowHref(row)).toBe("/notes/a");
  });

  it("a group names two bottles, then counts bottles (not pours) beyond that, and opens the profile", () => {
    const [row] = buildFriendRows(
      [
        item({ pourId: "a", bottleName: "A", createdAt: "2026-10-31T00:00:00.000Z" }),
        item({ pourId: "b", bottleName: "B", createdAt: "2026-10-30T00:00:00.000Z" }),
        item({ pourId: "c", bottleName: "C", createdAt: "2026-10-29T00:00:00.000Z" }),
        item({ pourId: "d", bottleName: "C", createdAt: "2026-10-28T00:00:00.000Z" }),
        item({ pourId: "e", bottleName: "D", createdAt: "2026-10-27T00:00:00.000Z" }),
      ],
      "viewer",
    );
    expect(friendRowSummary(row)).toBe("tasted A, B and 2 more");
    expect(friendRowHref(row)).toBe("/u/sasha");
  });

  it("never uses streak, volume or right-now language", () => {
    const rows = buildFriendRows(
      [item({ pourId: "a" }), item({ pourId: "b" }), item({ pourId: "c", author: remy, rating: null })],
      "viewer",
    );
    for (const r of rows) expect(friendRowSummary(r)).not.toMatch(/streak|pours?\b|drinks?\b|drinking|now\b|in a row/i);
  });
});

describe("paging and the stored tab", () => {
  it(`shows ${LATELY_PAGE} rows, then Show more reveals the rest`, () => {
    const rows = Array.from({ length: 8 }, (_, i) => i);
    expect(pageRows(rows, false)).toEqual({ shown: [0, 1, 2, 3, 4], hidden: 3 });
    expect(pageRows(rows, true)).toEqual({ shown: rows, hidden: 0 });
    expect(pageRows([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 });
  });

  it("defaults to You for anything but a stored Friends", () => {
    expect(parseLatelyTab(null)).toBe("you");
    expect(parseLatelyTab("garbage")).toBe("you");
    expect(parseLatelyTab("friends")).toBe("friends");
  });
});
