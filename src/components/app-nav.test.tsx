// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { AppNav } from "@/components/app-nav";

afterEach(cleanup);

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
});
