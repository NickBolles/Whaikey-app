// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { HomeStartHere, pickStartActions } from "./home-start-here";

afterEach(cleanup);

describe("pickStartActions", () => {
  it("a stocked bar with nothing planned: log, add bottles, plan a get-together", () => {
    const a = pickStartActions({ bottleCount: 12, hasTastedEver: false, hasNextOuting: false });
    expect(a.map((x) => x.key)).toEqual(["log", "scan", "plan"]);
    expect(a[0].title).toBe("Log your first tasting");
    expect(a[1].detail).toContain("12 on your shelf");
  });

  it("an empty shelf leads with adding bottles", () => {
    expect(pickStartActions({ bottleCount: 0, hasTastedEver: false, hasNextOuting: false }).map((x) => x.key)).toEqual(["scan", "log", "plan"]);
  });

  it("with an outing already planned, offers clubs instead of planning another", () => {
    const a = pickStartActions({ bottleCount: 3, hasTastedEver: true, hasNextOuting: true });
    expect(a.map((x) => x.key)).toEqual(["log", "scan", "club"]);
    expect(a[0].title).toBe("Log a tasting");
  });

  it("never offers more than three actions or pour/volume copy", () => {
    for (const bottleCount of [0, 1, 40]) {
      for (const hasTastedEver of [true, false]) {
        for (const hasNextOuting of [true, false]) {
          const a = pickStartActions({ bottleCount, hasTastedEver, hasNextOuting });
          expect(a.length).toBeLessThanOrEqual(3);
          const text = a.map((x) => `${x.title} ${x.detail}`).join(" ");
          expect(text).not.toMatch(/pours?\b|streak|blank|journey|unlock|—/i);
        }
      }
    }
  });
});

describe("HomeStartHere", () => {
  it("renders exactly one primary action", () => {
    render(<HomeStartHere actions={pickStartActions({ bottleCount: 12, hasTastedEver: false, hasNextOuting: false })} />);
    expect(screen.getByRole("region", { name: "Start here" })).toBeInTheDocument();
    expect(screen.getAllByTestId("start-primary")).toHaveLength(1);
    expect(screen.getByTestId("start-primary")).toHaveAttribute("href", "/pour");
    expect(screen.getByRole("link", { name: /Plan a get-together/ })).toHaveAttribute("href", "/outings/new");
  });

  it("renders nothing without actions", () => {
    const { container } = render(<HomeStartHere actions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
