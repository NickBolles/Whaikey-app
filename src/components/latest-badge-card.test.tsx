// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LatestBadgeCard, pickLatestBadge } from "@/components/latest-badge-card";
import type { Passport, PassportBadge } from "@/lib/passport";

afterEach(cleanup);

function badge(over: Partial<PassportBadge>): PassportBadge {
  return {
    family: "region",
    value: "Islay",
    label: "Islay",
    metCount: 3,
    catalogTotal: 24,
    currentTier: 2,
    heldTier: 2,
    achievedAt: { 1: new Date("2026-06-01T00:00:00Z"), 2: new Date("2026-07-01T00:00:00Z") },
    ...over,
  };
}

function passport(badges: PassportBadge[]): Passport {
  return {
    countries: badges.filter((b) => b.family === "country"),
    regions: badges.filter((b) => b.family === "region"),
    styles: badges.filter((b) => b.family === "style"),
  };
}

describe("pickLatestBadge", () => {
  it("returns null with no badge held", () => {
    expect(pickLatestBadge(passport([]))).toBeNull();
    expect(pickLatestBadge(passport([badge({ heldTier: 0, currentTier: 0, achievedAt: {} })]))).toBeNull();
  });

  it("prefers a tier earned but not yet stamped over any dated one", () => {
    const stamped = badge({ value: "Speyside", label: "Speyside" });
    const fresh = badge({ family: "country", value: "Japan", label: "Japan", currentTier: 1, heldTier: 1, achievedAt: {} });
    expect(pickLatestBadge(passport([stamped, fresh]))?.value).toBe("Japan");
  });

  it("otherwise picks the most recently stamped", () => {
    const older = badge({ value: "Speyside", label: "Speyside", achievedAt: { 1: new Date("2026-05-01T00:00:00Z") } });
    const newer = badge({ value: "Islay", label: "Islay", achievedAt: { 1: new Date("2026-07-10T00:00:00Z") } });
    expect(pickLatestBadge(passport([older, newer]))?.value).toBe("Islay");
  });

  it("orders unstamped tiers by tier, then name — never by when they were opened", () => {
    const a = badge({ value: "Islay", label: "Islay", currentTier: 1, heldTier: 1, achievedAt: {} });
    const b = badge({ value: "Campbeltown", label: "Campbeltown", currentTier: 2, heldTier: 2, achievedAt: {} });
    expect(pickLatestBadge(passport([a, b]))?.value).toBe("Campbeltown");
  });
});

describe("LatestBadgeCard", () => {
  it("shows the badge with its tier, distinct-bottle count and the next tier, linking to the badge", () => {
    render(<LatestBadgeCard badge={badge({})} />);
    expect(screen.getByText("Badge earned")).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/passport/region/Islay");
    expect(link).toHaveTextContent("Islay · Copper II");
    expect(link).toHaveTextContent("3 distinct bottles met · Silver at 6");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("says nothing about a next tier at the top of the ladder", () => {
    render(<LatestBadgeCard badge={badge({ currentTier: 5, heldTier: 5, metCount: 30 })} />);
    expect(screen.getByRole("link")).toHaveTextContent("30 distinct bottles met");
    expect(screen.getByRole("link").textContent).not.toMatch(/ at \d/);
  });
});
