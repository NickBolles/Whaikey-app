// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StarRating } from "@/components/star-rating";

afterEach(cleanup);

describe("StarRating hit area", () => {
  it("small stars keep 44px-tall half-star buttons", () => {
    render(<StarRating value={null} onChange={() => {}} size={30} />);
    const btn = screen.getByRole("button", { name: "Rate 0.5 stars" });
    expect(btn.style.top).toBe("-7px");
    expect(btn.style.bottom).toBe("-7px");
  });
  it("thumb-sized stars need no extension", () => {
    render(<StarRating value={null} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Rate 5 stars" }).style.top).toBe("");
  });
});
