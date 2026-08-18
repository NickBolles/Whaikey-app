// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SourceBackedResources } from "./source-backed-resources";

afterEach(cleanup);

const baseResource = {
  id: "resource-1",
  bottleId: "bottle-1",
  sourceId: "producer",
  resourceType: "official_product" as const,
  url: "https://producer.example/products/bottle",
  title: "Bottle official product page",
  publisher: "Example Producer",
  contentHash: "hash",
  matchMethod: "manifest" as const,
  confidence: 1,
  publishedAt: null,
  retrievedAt: new Date("2026-08-18T12:00:00Z"),
  createdAt: new Date("2026-08-18T12:00:00Z"),
  updatedAt: new Date("2026-08-18T12:00:00Z"),
  source: { id: "producer", name: "Example Producer", kind: "official" as const, attribution: null },
};

const bottleMedia = {
  id: "media-1",
  bottleId: "bottle-1",
  resourceId: "resource-1",
  kind: "bottle" as const,
  url: "https://producer.example/images/bottle.png",
  alt: "Example Reserve bottle",
  rights: "display_remote" as const,
  attribution: "Example Producer",
  width: 800,
  height: 1200,
  isPrimary: true,
  createdAt: new Date("2026-08-18T12:00:00Z"),
};

describe("SourceBackedResources", () => {
  it("renders permitted official imagery with attribution", () => {
    render(<SourceBackedResources bottleName="Example Reserve" resources={[baseResource]} media={[bottleMedia]} />);
    expect(screen.getByRole("img", { name: "Example Reserve bottle" })).toHaveAttribute("src", bottleMedia.url);
    expect(screen.getByText("Image: Example Producer")).toBeInTheDocument();
  });

  it("never renders link-only or review-required media", () => {
    render(<SourceBackedResources
      bottleName="Example Reserve"
      resources={[baseResource]}
      media={[
        { ...bottleMedia, id: "link", rights: "link_only" },
        { ...bottleMedia, id: "review", url: "https://reviews.example/photo.jpg", rights: "review_required" },
      ]}
    />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders a separately attributed distillery image when provided", () => {
    render(<SourceBackedResources
      bottleName="Example Reserve"
      resources={[{ ...baseResource, id: "distillery-page", resourceType: "distillery" }]}
      media={[{ ...bottleMedia, id: "distillery-image", kind: "distillery", alt: "Example Distillery exterior" }]}
    />);
    const section = screen.getByRole("region", { name: "Distillery image" });
    expect(within(section).getByRole("img", { name: "Example Distillery exterior" })).toBeInTheDocument();
  });

  it("groups official pages and independent reviews as outbound sources", () => {
    const review = {
      ...baseResource,
      id: "review",
      sourceId: "breaking-bourbon",
      resourceType: "review" as const,
      url: "https://www.breakingbourbon.com/review/example",
      title: "Example Reserve Review",
      publisher: "Breaking Bourbon",
      source: { id: "breaking-bourbon", name: "Breaking Bourbon", kind: "editorial" as const, attribution: "Breaking Bourbon" },
    };
    render(<SourceBackedResources bottleName="Example Reserve" resources={[baseResource, review]} media={[]} />);

    const official = screen.getByRole("region", { name: "Official sources" });
    const reviews = screen.getByRole("region", { name: "Independent reviews" });
    expect(within(official).getByRole("link", { name: /Official product/i })).toHaveAttribute("href", baseResource.url);
    expect(within(reviews).getByRole("link", { name: /Example Reserve Review/i })).toHaveAttribute("href", review.url);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    }
    expect(screen.getByText(/Facts and images stay attributed/i)).toBeInTheDocument();
  });
});
