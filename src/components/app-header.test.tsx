// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { AppHeader } from "@/components/app-header";

afterEach(() => {
  cleanup();
  pathname = "/";
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

  it("renders nothing on the immersive welcome wizard", () => {
    pathname = "/welcome";
    render(<AppHeader user={{ name: "Ada", image: null }} profileHandle="ada" />);
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("renders nothing on sign-in", () => {
    pathname = "/sign-in";
    render(<AppHeader user={null} profileHandle={null} />);
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });
});
