// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WHISKEY_CATEGORIES } from "@/db/schema";
import { PassportBadgeIcon, hasBespokeEmblem } from "./passport-badge";

afterEach(cleanup);

describe("PassportBadgeIcon", () => {
  it("labels the svg when standalone and hides it from AT when decorative", () => {
    render(<PassportBadgeIcon family="region" value="Islay" tier={3} label="Islay — Silver III" />);
    expect(screen.getByRole("img", { name: "Islay — Silver III" })).toBeInTheDocument();
    cleanup();
    const { container } = render(<PassportBadgeIcon family="region" value="Islay" tier={3} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the tier numeral banner at grid size and drops it below 36px", () => {
    const { container } = render(<PassportBadgeIcon family="country" value="Scotland" tier={4} size={48} />);
    expect(container.textContent).toContain("IV");
    cleanup();
    const small = render(<PassportBadgeIcon family="country" value="Scotland" tier={4} size={28} />);
    expect(small.container.textContent).not.toContain("IV");
  });

  it("shows the distinct-bottle count chip only when there is room for it", () => {
    const { container } = render(<PassportBadgeIcon family="region" value="Islay" tier={3} size={64} count={7} />);
    expect(container.textContent).toContain("7");
    cleanup();
    // A pour-card sized crest never renders the number.
    const small = render(<PassportBadgeIcon family="region" value="Islay" tier={3} size={32} count={7} />);
    expect(small.container.textContent).not.toContain("7");
  });

  it("clamps out-of-range tiers instead of crashing", () => {
    const { container } = render(<PassportBadgeIcon family="style" value="bourbon" tier={9} size={48} />);
    expect(container.textContent).toContain("V");
  });

  it("falls back to a monogram die for values without bespoke art", () => {
    expect(hasBespokeEmblem("region", "Ontario")).toBe(false);
    const { container } = render(<PassportBadgeIcon family="region" value="Ontario" tier={2} size={48} />);
    expect(container.textContent).toContain("O");
  });

  it("has bespoke art for every whiskey category and the core origin set", () => {
    for (const category of WHISKEY_CATEGORIES) {
      expect(hasBespokeEmblem("style", category), category).toBe(true);
    }
    for (const country of ["Scotland", "USA", "Ireland", "Japan", "Canada", "India", "Taiwan", "Australia", "Wales"]) {
      expect(hasBespokeEmblem("country", country), country).toBe(true);
    }
    // The six Scotch regions the catalog counts, plus the big American states.
    for (const region of ["Islay", "Speyside", "Highland", "Lowland", "Campbeltown", "Islands", "Kentucky", "Tennessee", "Texas"]) {
      expect(hasBespokeEmblem("region", region), region).toBe(true);
    }
  });

  it("keeps frame silhouettes distinct per family", () => {
    const shield = render(<PassportBadgeIcon family="country" value="Scotland" tier={1} />);
    expect(shield.container.querySelector("path[d^='M36 4']")).not.toBeNull();
    cleanup();
    const coin = render(<PassportBadgeIcon family="region" value="Islay" tier={1} />);
    expect(coin.container.querySelector("circle[r='31']")).not.toBeNull();
    cleanup();
    const hex = render(<PassportBadgeIcon family="style" value="bourbon" tier={1} />);
    expect(hex.container.querySelectorAll("polygon").length).toBeGreaterThan(0);
  });
});
