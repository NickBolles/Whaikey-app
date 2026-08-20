// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { YourPours, type YourPourItem } from "./your-pours";

afterEach(cleanup);

function pourItem(overrides: Partial<YourPourItem> & Pick<YourPourItem, "id" | "createdAt">): YourPourItem {
  return {
    rating: null,
    servingStyle: null,
    amountMl: null,
    snippet: null,
    ...overrides,
  };
}

/** Newest first, like listPours returns. */
const threeRated: YourPourItem[] = [
  pourItem({ id: "p3", createdAt: "2026-07-14T20:30:00Z", rating: 4.5, servingStyle: "neat", amountMl: 45, snippet: "Toffee and orchard fruit." }),
  pourItem({ id: "p2", createdAt: "2026-06-10T20:00:00Z", rating: 4 }),
  pourItem({ id: "p1", createdAt: "2026-04-20T19:00:00Z", rating: 3.5 }),
];

describe("YourPours", () => {
  it("averages the rated pours and shows count and range", () => {
    render(<YourPours bottleId="b1" pours={threeRated} />);
    const section = screen.getByRole("region", { name: "Your pours" });
    expect(section).toHaveTextContent("4.0"); // (3.5 + 4 + 4.5) / 3
    expect(section).toHaveTextContent("3 pours");
    expect(section).toHaveTextContent("3.5–4.5");
  });

  it("draws the rating trend oldest → newest once three pours are rated", () => {
    render(<YourPours bottleId="b1" pours={threeRated} />);
    const spark = screen.getByTestId("rating-sparkline");
    expect(spark).toHaveAccessibleName("Rating trend across 3 pours: 3.5, 4.0, 4.5");
  });

  it("holds the sparkline back below three rated pours", () => {
    render(<YourPours bottleId="b1" pours={threeRated.slice(0, 2)} />);
    expect(screen.queryByTestId("rating-sparkline")).not.toBeInTheDocument();
  });

  it("lists the most recent pours with date, style, rating, and note snippet", () => {
    render(<YourPours bottleId="b1" pours={threeRated} />);
    // "Jul 14" also closes the sparkline caption, so at least the list row.
    expect(screen.getAllByText("Jul 14").length).toBeGreaterThan(0);
    expect(screen.getByText("Neat · 45 ml")).toBeInTheDocument();
    expect(screen.getByText("Toffee and orchard fruit.")).toBeInTheDocument();
    // Three pours fit inline, so no journal link is needed.
    expect(screen.queryByRole("link", { name: /All \d+ pours/ })).not.toBeInTheDocument();
  });

  it("caps the inline list at three and links the rest to the journal", () => {
    const four = [
      pourItem({ id: "p4", createdAt: "2026-07-20T20:00:00Z", rating: 5 }),
      ...threeRated,
    ];
    render(<YourPours bottleId="b1" pours={four} />);
    expect(screen.getByRole("link", { name: "All 4 pours →" })).toHaveAttribute(
      "href",
      "/history?bottleId=b1",
    );
    // The oldest pour dropped off the inline list (its date may still anchor
    // the sparkline caption — the trend always spans the full history).
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.textContent?.includes("Apr 20"))).toBe(false);
  });

  it("shows years only when the history spans more than one", () => {
    const spanning = [
      pourItem({ id: "p2", createdAt: "2026-01-05T20:00:00Z", rating: 4 }),
      pourItem({ id: "p1", createdAt: "2025-12-30T20:00:00Z", rating: 3.5 }),
    ];
    render(<YourPours bottleId="b1" pours={spanning} />);
    expect(screen.getByText("Jan 5, 2026")).toBeInTheDocument();
    expect(screen.getByText("Dec 30, 2025")).toBeInTheDocument();
  });

  it("counts unrated pours honestly instead of inventing an average", () => {
    const unrated = [
      pourItem({ id: "p2", createdAt: "2026-07-14T20:30:00Z" }),
      pourItem({ id: "p1", createdAt: "2026-06-10T20:00:00Z" }),
    ];
    render(<YourPours bottleId="b1" pours={unrated} />);
    expect(screen.getByText(/2 pours logged, none rated yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("rating-sparkline")).not.toBeInTheDocument();
  });

  it("renders nothing at all without pours", () => {
    const { container } = render(<YourPours bottleId="b1" pours={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
