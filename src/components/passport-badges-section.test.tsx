// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Passport, PassportBadge } from "@/lib/passport";
import { PassportBadgesSection } from "./passport-badges-section";

afterEach(cleanup);

function badge(overrides: Partial<PassportBadge> = {}): PassportBadge {
  return {
    family: "region",
    value: "Islay",
    label: "Islay",
    metCount: 7,
    catalogTotal: 24,
    currentTier: 3,
    heldTier: 3,
    achievedAt: {},
    ...overrides,
  };
}

function passport(overrides: Partial<Passport> = {}): Passport {
  return { countries: [], regions: [badge()], styles: [], ...overrides };
}

describe("PassportBadgesSection", () => {
  it("renders the owner's badge as a link to its detail page with counts", () => {
    render(<PassportBadgesSection passport={passport()} isSelf={true} />);
    const link = screen.getByRole("link", {
      name: "Islay — Silver III, 7 of 24 catalog bottles. Opens badge details.",
    });
    expect(link).toHaveAttribute("href", "/passport/region/Islay");
    expect(screen.getByRole("tooltip")).toHaveTextContent("7 of 24 catalog bottles");
  });

  it("renders another user's badge without a link and without any count", () => {
    render(<PassportBadgesSection passport={passport()} isSelf={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    // Focusable so the tooltip is reachable by keyboard, labeled by tier only.
    const tile = screen.getByRole("img", { name: "Islay — Silver III" });
    expect(tile).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("7 of 24");
  });

  it("URL-encodes values in badge hrefs", () => {
    const p = passport({ regions: [badge({ value: "County Antrim", label: "County Antrim", heldTier: 1, currentTier: 1 })] });
    render(<PassportBadgesSection passport={p} isSelf={true} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/passport/region/County%20Antrim");
  });

  it("renders nothing when the passport is empty", () => {
    const { container } = render(<PassportBadgesSection passport={{ countries: [], regions: [], styles: [] }} isSelf={true} />);
    expect(container.innerHTML).toBe("");
  });

  it("omits empty rows but keeps populated ones", () => {
    const p = passport({ countries: [badge({ family: "country", value: "Scotland", label: "Scotland" })] });
    render(<PassportBadgesSection passport={p} isSelf={false} />);
    expect(screen.getByText("Passport · Countries")).toBeInTheDocument();
    expect(screen.getByText("Regions")).toBeInTheDocument();
    expect(screen.queryByText("Styles")).toBeNull();
  });
});
