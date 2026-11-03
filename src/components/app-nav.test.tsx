// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

let pathname = "/";
const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push }) }));

import { AppNav, LONG_PRESS_MS } from "@/components/app-nav";
import { arcPositions, quickItems } from "@/components/discover-quick-menu";

afterEach(() => {
  cleanup();
  pathname = "/";
});

describe("AppNav", () => {
  it("is Home · Bar · ＋ · Discover · Social, and ＋ opens the pour sheet directly", () => {
    render(<AppNav />);
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    const links = nav.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/", "/bar", "/pour", "/discover", "/friends"]);
    expect(links.map((l) => l.textContent || l.getAttribute("aria-label"))).toEqual(["Home", "Bar", "Log a pour", "Discover", "Social"]);
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
  it("stands down on the signed-out front door, and only there", () => {
    pathname = "/";
    const { container, unmount } = render(<AppNav signedIn={false} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    pathname = "/search";
    render(<AppNav signedIn={false} />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it.each(["/discover", "/search", "/chat", "/learn/flavors", "/passport/country/Scotland"])("lights Discover on %s", (path) => {
    pathname = path;
    render(<AppNav />);
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: /Discover/ })).toHaveAttribute("aria-current", "page");
  });

  it("opens the quick menu on a second tap of a lit Discover, and Esc closes it back to the tab", () => {
    pathname = "/discover";
    render(<AppNav aiEnabled passportHref="/u/ada" />);
    const tab = screen.getByRole("link", { name: /Discover/ });
    expect(tab).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(tab);
    const menu = screen.getByRole("menu", { name: "Discover shortcuts" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Ask", "Learn", "Find", "Flavors", "Passport"]);
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowRight" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowLeft" });
    expect(items[4]).toHaveFocus();
    fireEvent.keyDown(items[4], { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(tab).toHaveFocus();
  });

  it("a plain tap on Discover from another tab navigates instead of opening the menu", () => {
    pathname = "/bar";
    render(<AppNav aiEnabled />);
    fireEvent.click(screen.getByRole("link", { name: /Discover/ }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens on a long-press from any tab, leaving Ask out without AI and Passport out without a profile", () => {
    vi.useFakeTimers();
    try {
      pathname = "/";
      render(<AppNav aiEnabled={false} />);
      fireEvent.pointerDown(screen.getByRole("link", { name: /Discover/ }), { button: 0 });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS + 10);
      });
      const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
      expect(items.map((i) => i.getAttribute("href"))).toEqual(["/learn", "/search", "/learn/flavors"]);
      fireEvent.click(screen.getByTestId("quick-menu-scrim"));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lays the arc out above the bar and inside the screen edge", () => {
    expect(quickItems(true, "/u/ada")).toHaveLength(5);
    expect(quickItems(false, null)).toHaveLength(3);
    // The Discover tab on a 390px phone: 4th of 5 columns, bar top at 770.
    const pos = arcPositions(5, { left: 234, top: 770, width: 78 }, 390);
    for (const p of pos) {
      expect(p.top + 56).toBeLessThan(770); // never over the bar
      expect(p.left).toBeGreaterThanOrEqual(8);
      expect(p.left + 56).toBeLessThanOrEqual(390 - 10);
    }
  });
});
