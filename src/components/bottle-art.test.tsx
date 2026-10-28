// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/bottle-art", async (orig) => {
  const real = await orig<typeof import("@/lib/bottle-art")>();
  return { ...real, displayableImage: (url: string | null | undefined) => (url?.startsWith("https://cdn.example.com/") ? url : null) };
});
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- test double for next/image
  default: (props: { src: string; alt: string }) => <img src={props.src} alt={props.alt} data-testid="remote-image" />,
}));

import { BottleArt } from "@/components/bottle-art";

afterEach(cleanup);

describe("BottleArt", () => {
  it("draws the silhouette with the distillery monogram when there is no licensed image", () => {
    render(<BottleArt name="Eagle Rare 10" category="bourbon" distillery="Buffalo Trace" imageUrl="https://elsewhere.example.com/x.png" />);
    expect(screen.getByTestId("bottle-art")).toHaveTextContent("BT");
    expect(screen.queryByTestId("remote-image")).not.toBeInTheDocument();
  });
  it("uses the licensed image when the policy allows it", () => {
    render(<BottleArt name="Lagavulin 16" category="scotch-single-malt" imageUrl="https://cdn.example.com/l16.png" height={80} />);
    expect(screen.getByTestId("remote-image")).toHaveAttribute("src", "https://cdn.example.com/l16.png");
  });
  it("falls back to the bottle name's initials and tints by cask", () => {
    const { container } = render(<BottleArt name="Single Cask" category="scotch-single-malt" cask="Oloroso sherry" />);
    expect(screen.getByTestId("bottle-art")).toHaveTextContent("SC");
    expect(container.innerHTML).toContain("#7a3420");
  });
});
