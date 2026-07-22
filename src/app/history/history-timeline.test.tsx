// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { HistoryTimeline, type TimelinePour } from "./history-timeline";

afterEach(cleanup);

function pour(over: Partial<TimelinePour> = {}): TimelinePour {
  return {
    id: over.id ?? "p1",
    bottleId: "b1",
    bottleName: over.bottleName ?? "Test Bourbon",
    rating: over.rating ?? 4,
    servingStyle: over.servingStyle ?? "neat",
    amountMl: over.amountMl ?? 30,
    createdAt: over.createdAt ?? "2026-03-14T18:30:00.000Z",
    note: over.note ?? null,
  };
}

describe("HistoryTimeline", () => {
  it("renders every pour row on first paint and after mount", async () => {
    render(
      <HistoryTimeline
        pours={[
          pour({ id: "a", bottleName: "Bottle A" }),
          pour({ id: "b", bottleName: "Bottle B", createdAt: "2026-03-13T18:30:00.000Z" }),
        ]}
      />,
    );
    // A microtask flush lets the mount effect run so day headers appear.
    await act(async () => {});
    expect(screen.getByText("Bottle A")).toBeInTheDocument();
    expect(screen.getByText("Bottle B")).toBeInTheDocument();
  });

  it("groups pours from the same local day under one heading", async () => {
    render(
      <HistoryTimeline
        pours={[
          pour({ id: "a", createdAt: "2026-03-14T14:00:00.000Z" }),
          pour({ id: "b", createdAt: "2026-03-14T20:00:00.000Z" }),
        ]}
      />,
    );
    await act(async () => {});
    // Two same-day pours collapse into a single day <section>.
    const sections = screen.getAllByRole("region");
    expect(sections).toHaveLength(1);
  });

  it("formats the pour time using Intl (viewer timezone), not a raw ISO string", async () => {
    render(<HistoryTimeline pours={[pour({ createdAt: "2026-03-14T18:30:00.000Z" })]} />);
    await act(async () => {});
    const expected = new Date("2026-03-14T18:30:00.000Z").toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
  });
});
