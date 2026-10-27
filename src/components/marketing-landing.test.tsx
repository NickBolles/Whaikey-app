// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketingLanding } from "@/components/marketing-landing";

afterEach(cleanup);

describe("MarketingLanding", () => {
  it("is a landing page with one way in, and keeps the responsible-drinking stance on it", () => {
    render(<MarketingLanding />);
    expect(screen.getByRole("heading", { level: 1, name: "Caskfolk" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/sign-in");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    expect(screen.getByRole("heading", { name: "Outings and tasting nights" })).toBeInTheDocument();
    expect(screen.getByText(/no streaks, no volume badges, no leaderboards/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /drinking responsibly →/i })).toHaveAttribute("href", "/responsible");
    // The app's chrome is not part of the landing.
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
  });
});
