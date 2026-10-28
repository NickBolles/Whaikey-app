// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GatherModule } from "@/components/gather-module";

afterEach(cleanup);

describe("GatherModule", () => {
  it("leads with the next outing and links clubs, tasting nights and trails", () => {
    render(
      <GatherModule
        data={{ nextOuting: { title: "Bourbon Trail", distilleryName: "Buffalo Trace", joinCode: "abc", dayLabel: "Thu, Oct 29" }, clubCount: 2, openNights: 1 }}
      />,
    );
    const next = screen.getByTestId("gather-next-outing");
    expect(next).toHaveAttribute("href", "/o/abc");
    expect(next).toHaveTextContent("Thu, Oct 29 · Outing");
    expect(next).toHaveTextContent("Buffalo Trace");
    expect(screen.getByRole("link", { name: /Clubs\s*2 joined/ })).toHaveAttribute("href", "/clubs");
    expect(screen.getByRole("link", { name: /Tasting night\s*1 open/ })).toHaveAttribute("href", "/clubs#nights-heading");
    expect(screen.getByRole("heading", { name: "Get together" })).toBeInTheDocument();
  });

  it("offers to plan an outing and host a night when there is nothing yet; compact drops the heading", () => {
    render(<GatherModule data={{ nextOuting: null, clubCount: 0, openNights: 0 }} compact />);
    expect(screen.getByRole("link", { name: /Plan a distillery outing/ })).toHaveAttribute("href", "/outings/new");
    expect(screen.getByRole("link", { name: /Tasting night\s*Host blind/ })).toHaveAttribute("href", "/flights/new");
    expect(screen.getByRole("link", { name: /Clubs\s*Start one/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Get together" })).not.toBeInTheDocument();
  });
});
