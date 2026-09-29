// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { AppNav } from "@/components/app-nav";

afterEach(() => {
  cleanup();
  pathname = "/";
});

describe("AppNav", () => {
  it("keeps primary destinations focused and reveals secondary creation actions on demand", () => {
    render(<AppNav />);

    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    for (const label of ["Home", "My Bar", "Friends", "Chat"]) {
      expect(nav.getByText(label)).toBeInTheDocument();
    }
    expect(nav.getByRole("link", { name: /Friends/ })).toHaveAttribute("href", "/friends");
    // Search left the tab bar in the 2026-08 IA redesign — it lives in the
    // global header and the quick-actions sheet.
    expect(nav.queryByText("Search")).not.toBeInTheDocument();
    expect(nav.queryByText("Pour")).not.toBeInTheDocument();
    expect(nav.queryByText("Scan")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open quick actions" }));
    expect(screen.getByRole("link", { name: /Log a pour/i })).toHaveAttribute("href", "/pour");
    expect(screen.getByRole("link", { name: /Scan a bottle/i })).toHaveAttribute("href", "/scan");
    expect(screen.getByRole("link", { name: /Find a bottle/i })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("button", { name: "Close quick actions" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Quick actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open quick actions" })).toHaveFocus();
  });

  it("holds the page still behind the quick-actions sheet and restores it on close", () => {
    render(<AppNav />);
    expect(document.body.style.position).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Open quick actions" }));
    // The sheet covers the screen; without this the page scrolls under it and
    // the sheet's own scroll chains into the page at either end.
    expect(document.body.style.position).toBe("fixed");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.position).toBe("");
    expect(document.body.style.overflow).toBe("");
  });

  it("marks the current tab, and nothing for a route under none of them", () => {
    pathname = "/bar";
    render(<AppNav />);
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: /My Bar/ })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: /Home/ })).not.toHaveAttribute("aria-current");
  });

  /**
   * Review UX-14: the nav rendered on sign-in, the welcome tour and share
   * pages — five tabs a signed-out visitor to a share link cannot use.
   */
  it.each(["/sign-in", "/welcome", "/s/sashalagav16", "/age", "/app-update"])(
    "renders nothing on the chromeless route %s",
    (path) => {
      pathname = path;
      render(<AppNav />);
      expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open quick actions" })).not.toBeInTheDocument();
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
