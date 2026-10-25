// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { AppNav } from "@/components/app-nav";

afterEach(() => {
  cleanup();
  pathname = "/";
});

describe("AppNav", () => {
  it("is Home · Bar · ＋ · Explore · Social, and ＋ opens the pour sheet directly", () => {
    render(<AppNav />);
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    const links = nav.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/", "/bar", "/pour", "/search", "/friends"]);
    expect(links.map((l) => l.textContent || l.getAttribute("aria-label"))).toEqual(["Home", "Bar", "Log a pour", "Explore", "Social"]);
    // Chat left the nav (STORYBOARD D1): it is an affordance, not a tab.
    expect(nav.queryByText("Chat")).not.toBeInTheDocument();
    // No interstitial menu between ＋ and the sheet (design board S1).
    expect(nav.queryByRole("button")).not.toBeInTheDocument();
  });

  it("marks the current tab, and nothing for a route under none of them", () => {
    pathname = "/bar";
    render(<AppNav />);
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: /Bar/ })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: /Home/ })).not.toHaveAttribute("aria-current");
  });

  it("does not mark Social on a route that merely shares its prefix", () => {
    pathname = "/friendship";
    render(<AppNav />);
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: /Social/ })).not.toHaveAttribute("aria-current");
  });

  it.each(["/sign-in", "/welcome", "/s/sashalagav16", "/age", "/app-update", "/pour"])(
    "renders nothing on the chromeless route %s",
    (path) => {
      pathname = path;
      render(<AppNav />);
      expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    },
  );

  it.each(["/search", "/scan", "/sharing", "/bottles/eagle-rare-10"])(
    "still renders on %s, which only shares a prefix with a chromeless route",
    (path) => {
      pathname = path;
      render(<AppNav />);
      expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    },
  );

  it("marks itself so the toast region can sit above it", () => {
    render(<AppNav />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toHaveAttribute("data-app-nav");
  });
});
