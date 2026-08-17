// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));
vi.mock("@/db/schema", () => ({ SERVING_STYLES: ["neat", "rocks", "cocktail"] }));
vi.mock("@/components/star-rating", () => ({ StarRating: () => <div aria-label="Star rating" /> }));
vi.mock("@/components/flavor-wheel-input", () => ({
  FlavorWheelInput: () => <div aria-label="Flavor wheel" />,
}));
vi.mock("@/components/note-capture", () => ({
  NoteCapture: () => <textarea aria-label="Capture tasting note" />,
}));
vi.mock("@/lib/native/offline-queue", () => ({ enqueuePour: vi.fn() }));

import { PourFlow } from "@/app/pour/pour-flow";

afterEach(cleanup);

describe("PourFlow tasting notes", () => {
  it("keeps tasting-note fields visible instead of hiding the app's primary capture surface", () => {
    render(<PourFlow initialBottle={{ id: "bottle-1", name: "Test Bourbon" }} />);

    expect(screen.getByPlaceholderText("What do you smell?")).toBeVisible();
    expect(screen.getByPlaceholderText("What do you taste?")).toBeVisible();
    expect(screen.getByPlaceholderText("How does it linger?")).toBeVisible();
    expect(screen.getByLabelText("Flavor wheel")).toBeVisible();
    expect(screen.queryByRole("button", { name: /tasting notes/i })).not.toBeInTheDocument();
  });
});
