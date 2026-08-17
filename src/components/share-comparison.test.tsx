// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ShareComparison } from "@/components/share-comparison";

afterEach(cleanup);

describe("ShareComparison", () => {
  it("renders the three comparison groups with their descriptors", () => {
    render(<ShareComparison mine={{ vanilla: 2, oak: 1 }} theirs={{ vanilla: 2, peat: 3 }} />);

    expect(screen.getByText("You both got…")).toBeInTheDocument();
    expect(screen.getByText("Vanilla")).toBeInTheDocument();

    expect(screen.getByText("They got — you didn't")).toBeInTheDocument();
    expect(screen.getByText("Earthy peat")).toBeInTheDocument();

    expect(screen.getByText("You got — they didn't")).toBeInTheDocument();
    expect(screen.getByText("Oak")).toBeInTheDocument();
  });

  it("shows the empty-overlap copy when nothing is shared", () => {
    render(<ShareComparison mine={{ oak: 1 }} theirs={{ peat: 3 }} />);

    expect(screen.getByText("No descriptors in common — that's a conversation.")).toBeInTheDocument();
    expect(screen.queryByText("You both got…")).not.toBeInTheDocument();
  });

  it("handles null/empty inputs without crashing", () => {
    render(<ShareComparison mine={null} theirs={undefined} />);
    expect(screen.getByText("No descriptors in common — that's a conversation.")).toBeInTheDocument();
  });
});
