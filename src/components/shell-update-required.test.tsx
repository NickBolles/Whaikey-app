// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ShellUpdateRequired } from "./shell-update-required";

/**
 * The screen a bad deploy still renders (docs/STORYBOARD.md §3.15). The visual
 * baseline covers `/app-update`, which has no installed binary to report — so
 * the parts only the native shell supplies are pinned here.
 */
afterEach(cleanup);

describe("ShellUpdateRequired", () => {
  it("says what happened without promising anything it can't keep", () => {
    render(<ShellUpdateRequired />);
    expect(screen.getByRole("heading", { name: "Update Whaikey" })).toBeInTheDocument();
    // The one reassurance offered, and it is true: the pour queue is local and
    // survives an update.
    expect(screen.getByText(/nothing you've logged is lost/i)).toBeInTheDocument();
  });

  it("shows the versions the shell found, for a support reply to work from", () => {
    render(<ShellUpdateRequired installed="1.2.0" required="1.4.0" />);
    expect(screen.getByText(/installed 1\.2\.0 · needs 1\.4\.0/i)).toBeInTheDocument();
  });

  it("offers the store when there is one, and no dead button when there isn't", () => {
    const { unmount } = render(<ShellUpdateRequired storeUrl="https://apps.apple.com/app/id1" />);
    expect(screen.getByRole("link", { name: /get the update/i })).toHaveAttribute(
      "href",
      "https://apps.apple.com/app/id1",
    );
    unmount();

    render(<ShellUpdateRequired />);
    expect(screen.queryByRole("link", { name: /get the update/i })).toBeNull();
  });

  it("prefers the outage's own notice over the default line", () => {
    render(<ShellUpdateRequired notice="A bad build went out; please update." />);
    expect(screen.getByText("A bad build went out; please update.")).toBeInTheDocument();
    expect(screen.queryByText(/too old for what's on the shelf/i)).toBeNull();
  });
});
