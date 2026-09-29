// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import NotFound from "@/app/not-found";
import RouteError from "@/app/error";
import BottleNotFound from "@/app/bottles/[id]/not-found";
import ProfileNotFound from "@/app/u/[handle]/not-found";
import HomeLoading from "@/app/(home)/loading";
import BarLoading from "@/app/bar/loading";
import BottleLoading from "@/app/bottles/[id]/loading";
import HistoryLoading from "@/app/history/loading";
import ProfileLoading from "@/app/u/[handle]/loading";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Review REL-6.2 / UX-12: the app had no loading, error or not-found state. */
describe("not-found boundaries", () => {
  it("the root 404 is branded, says what happened, and has one way home", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Nothing poured here" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
  });

  it("a missing bottle points at the catalog", () => {
    render(<BottleNotFound />);
    expect(screen.getByRole("heading", { name: "We can't find that bottle" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search the catalog" })).toHaveAttribute("href", "/search");
  });

  it("a missing profile does not say whether it exists, and points at Friends", () => {
    render(<ProfileNotFound />);
    expect(screen.getByRole("heading", { name: "No one by that handle" })).toBeInTheDocument();
    expect(screen.queryByText(/blocked|suspended|private/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Find friends" })).toHaveAttribute("href", "/friends");
  });
});

describe("route error boundary", () => {
  it("offers a retry that re-fetches the segment, and a way home", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    render(<RouteError error={Object.assign(new Error("pooler blip"), { digest: "abc123" })} unstable_retry={retry} />);

    expect(screen.getByRole("heading", { name: "Something spilled" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
  });

  it("shows the digest for a support reply, never the server's message", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <RouteError
        error={Object.assign(new Error("relation \"pours\" does not exist"), { digest: "abc123" })}
        unstable_retry={vi.fn()}
      />,
    );
    expect(screen.getByText("Ref abc123")).toBeInTheDocument();
    expect(screen.queryByText(/relation/)).not.toBeInTheDocument();
  });
});

describe("loading skeletons", () => {
  it.each([
    ["Home", HomeLoading, "Loading your home"],
    ["My Bar", BarLoading, "Loading your bar"],
    ["Bottle", BottleLoading, "Loading bottle"],
    ["Journal", HistoryLoading, "Loading your journal"],
    ["Profile", ProfileLoading, "Loading profile"],
  ] as const)("%s announces itself once and hides its grey shapes", (_name, Loading, label) => {
    const { container } = render(<Loading />);
    const status = screen.getByRole("status", { name: label });
    expect(status).toHaveAttribute("aria-busy", "true");
    // Every shape is decorative; the label is the only thing read out.
    for (const bone of container.querySelectorAll(".bg-surface-raised")) {
      expect(bone.closest("[aria-hidden='true']")).not.toBeNull();
    }
  });
});
