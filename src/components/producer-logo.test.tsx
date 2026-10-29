// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- test double for next/image that keeps onError/loading
  default: (props: { src: string; alt: string; loading?: "lazy" | "eager"; onError?: () => void; sizes?: string }) => (
    <img src={props.src} alt={props.alt} loading={props.loading} sizes={props.sizes} onError={props.onError} data-testid="remote-image" />
  ),
}));

import { markTone, plateWidth, ProducerLogo } from "@/components/producer-logo";
import { RemoteBottleImage } from "@/components/remote-bottle-image";

afterEach(cleanup);

describe("ProducerLogo", () => {
  it("draws the mark lazily on a white plate, never stretched", () => {
    render(<ProducerLogo logoKey="glenfiddich" name="Glenfiddich" size={30} />);
    const img = screen.getByRole("img", { name: "Glenfiddich logo" });
    expect(img).toHaveAttribute("src", "/api/brand-logo/glenfiddich");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("width", "22");
    expect(img.className).toContain("object-contain");
    expect(screen.getByTestId("producer-logo").className).toContain("bg-white");
  });
  it("moves a white-on-transparent mark onto a dark plate once it loads", () => {
    const white = new Uint8ClampedArray(24 * 24 * 4);
    for (let i = 0; i < white.length; i += 4) {
      // a third transparent, the rest opaque white
      const on = (i / 4) % 3 !== 0;
      white.set(on ? [255, 255, 255, 255] : [0, 0, 0, 0], i);
    }
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
      getImageData: () => ({ data: white }),
    } as unknown as CanvasRenderingContext2D);
    render(<ProducerLogo logoKey="bowmore" name="Bowmore" size={30} />);
    expect(screen.getByTestId("producer-logo").className).toContain("bg-white");
    fireEvent.load(screen.getByRole("img"));
    expect(screen.getByTestId("producer-logo").className).toContain("bg-[#2b2620]");
    spy.mockRestore();
  });
  it("keeps a dark or unreadable mark on the white plate", () => {
    const ink = new Uint8ClampedArray(24 * 24 * 4).fill(40);
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
      getImageData: () => ({ data: ink.map((v, i) => (i % 4 === 3 ? 255 : v)) }),
    } as unknown as CanvasRenderingContext2D);
    render(<ProducerLogo logoKey="ardbeg-ink" name="Ink" />);
    fireEvent.load(screen.getByRole("img"));
    expect(screen.getByTestId("producer-logo").className).toContain("bg-white");
    spy.mockReturnValue(null);
    expect(markTone(document.createElement("img"))).toBe("dark");
    spy.mockRestore();
  });
  it("widens the plate to a wide wordmark's aspect ratio, capped by maxWidth", () => {
    render(<ProducerLogo logoKey="wide-mark" name="Wide" size={30} maxWidth={96} />);
    const img = screen.getByRole("img");
    Object.defineProperty(img, "naturalWidth", { value: 400 });
    Object.defineProperty(img, "naturalHeight", { value: 100 });
    fireEvent.load(img);
    // inner height 22 × 4 + padding 8 = 96 (the cap)
    expect(screen.getByTestId("producer-logo").style.width).toBe("96px");
    expect(screen.getByTestId("producer-logo").style.height).toBe("30px");
    expect(plateWidth(2, 30, 4, 96)).toBe(52);
    expect(plateWidth(0.5, 30, 4, 96)).toBe(30); // tall marks stay square
    expect(plateWidth(undefined, 18, 2, 54)).toBe(18);
    expect(plateWidth(10, 18, 2, 54)).toBe(54);
  });
  it("falls back to the monogram when the logo fails, or to nothing on cards", () => {
    const { rerender } = render(<ProducerLogo logoKey="x" name="Buffalo Trace" />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByTestId("producer-monogram")).toHaveTextContent("BT");
    rerender(<ProducerLogo logoKey={null} name="Lagavulin" fallback="none" />);
    expect(screen.queryByTestId("producer-monogram")).toBeNull();
    expect(screen.queryByTestId("producer-logo")).toBeNull();
  });
});

describe("RemoteBottleImage", () => {
  it("lazy-loads with a size hint and swaps to the silhouette on error", () => {
    render(<RemoteBottleImage src="https://cdn.example.com/a.png" width={24} height={56} fallback={<svg data-testid="silhouette" />} />);
    const img = screen.getByTestId("remote-image");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("sizes", "24px");
    fireEvent.error(img);
    expect(screen.getByTestId("silhouette")).toBeInTheDocument();
    expect(screen.queryByTestId("remote-image")).toBeNull();
  });
});
