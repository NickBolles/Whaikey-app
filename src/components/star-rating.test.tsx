// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StarRating } from "@/components/star-rating";

afterEach(cleanup);

describe("StarRating", () => {
  it("clicking the right half of the 4th star sets a full 4", async () => {
    const onChange = vi.fn();
    render(<StarRating value={null} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Rate 4 stars" }));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it("clicking the left half of the 4th star sets 3.5", async () => {
    const onChange = vi.fn();
    render(<StarRating value={null} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Rate 3.5 stars" }));
    expect(onChange).toHaveBeenCalledWith(3.5);
  });

  it("renders ten half-star targets and marks the current value pressed", () => {
    render(<StarRating value={2.5} onChange={() => {}} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Rate 2.5 stars" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Rate 3 stars" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows the numeric value", () => {
    render(<StarRating value={4.5} onChange={() => {}} />);
    expect(screen.getByText("4.5")).toBeInTheDocument();
  });
});
