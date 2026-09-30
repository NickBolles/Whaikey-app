// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let pathname = "/";
const router = { back: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => router }));

import { AppHeader } from "@/components/app-header";
import { recordNavigation, resetNavHistoryForTests, resetNavigation } from "@/lib/nav-history";

afterEach(() => {
  cleanup();
  pathname = "/";
  resetNavHistoryForTests();
  vi.clearAllMocks();
});

describe("AppHeader", () => {
  it("shows the wordmark plus search, journal and profile links when signed in with a social profile", () => {
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);

    expect(screen.getByRole("link", { name: "Whaikey" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Search" })).toHaveAttribute("href", "/search");
    expect(screen.getByRole("link", { name: "Journal" })).toHaveAttribute("href", "/history");
    expect(screen.getByRole("link", { name: "Your profile" })).toHaveAttribute("href", "/u/ada");
  });

  it("points the avatar at /friends when the user has no social profile yet", () => {
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle={null} />);
    expect(screen.getByRole("link", { name: "Your profile" })).toHaveAttribute("href", "/friends");
  });

  it("shows only the wordmark and search when signed out", () => {
    render(<AppHeader user={null} profileHandle={null} />);

    expect(screen.getByRole("link", { name: "Whaikey" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Journal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Your profile" })).not.toBeInTheDocument();
  });

  it.each(["/welcome", "/sign-in", "/s/sashalagav16", "/age", "/app-update"])(
    "renders nothing on the chromeless route %s",
    (path) => {
      pathname = path;
      render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);
      expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    },
  );
});

/** Review UX-1: "No back navigation; iOS bottle page is a dead end". */
describe("AppHeader back slot", () => {
  it.each(["/", "/bar", "/friends", "/chat"])("keeps the wordmark, not a back button, on the tab route %s", (path) => {
    pathname = path;
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);
    expect(screen.getByRole("link", { name: "Whaikey" })).toBeInTheDocument();
    expect(screen.queryByTestId("header-back")).not.toBeInTheDocument();
  });

  it("replaces the wordmark with back on a non-tab route, keeping the trailing actions", () => {
    pathname = "/bottles/eagle-rare-10";
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);

    expect(screen.queryByRole("link", { name: "Whaikey" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to My Bar" })).toHaveAttribute("href", "/bar");
    expect(screen.getByRole("link", { name: "Search" })).toBeInTheDocument();
  });

  it("with no in-app history, is a plain link to the route's logical parent", () => {
    pathname = "/bottles/eagle-rare-10";
    resetNavigation(pathname); // a deep link: nothing behind this page
    render(<AppHeader user={null} profileHandle={null} />);

    const back = screen.getByRole("link", { name: "Back to Search" });
    expect(back).toHaveAttribute("href", "/search");
    fireEvent.click(back);
    // The Link navigates on its own; history is not touched, so back can
    // never step out of the app.
    expect(router.back).not.toHaveBeenCalled();
  });

  it("names the page the user came from, and goes back through history to it", () => {
    resetNavigation("/history");
    recordNavigation("/bottles/eagle-rare-10");
    pathname = "/bottles/eagle-rare-10";
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);

    const back = screen.getByRole("link", { name: "Back to Journal" });
    expect(back).toHaveTextContent("Journal");
    fireEvent.click(back);
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it("leaves a modified click (open in new tab) to the browser", () => {
    resetNavigation("/search");
    recordNavigation("/bottles/eagle-rare-10");
    pathname = "/bottles/eagle-rare-10";
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);

    fireEvent.click(screen.getByRole("link", { name: "Back to Search" }), { metaKey: true });
    expect(router.back).not.toHaveBeenCalled();
  });

  it("updates its label when the trail changes under it", () => {
    pathname = "/bottles/lagavulin-16";
    resetNavigation(pathname);
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);
    expect(screen.getByRole("link", { name: "Back to My Bar" })).toBeInTheDocument();

    act(() => {
      resetNavigation("/u/sasha");
      recordNavigation("/bottles/lagavulin-16");
    });
    expect(screen.getByRole("link", { name: "Back to @sasha" })).toBeInTheDocument();
  });

  it("says Back for a previous page it has no name for", () => {
    resetNavigation("/some-unknown-place");
    recordNavigation("/terms");
    pathname = "/terms";
    render(<AppHeader user={null} profileHandle={null} />);
    expect(screen.getByRole("link", { name: "Back" })).toHaveTextContent("Back");
  });

  it("sends a passport badge back to the viewer's profile", () => {
    pathname = "/passport/country/Scotland";
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);
    expect(screen.getByRole("link", { name: "Back to Profile" })).toHaveAttribute("href", "/u/ada");
  });
});
