// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DashboardData } from "@/lib/dashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { Dashboard, monthFacts } from "./dashboard";

afterEach(cleanup);

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    monthName: "July",
    prevMonthName: "June",
    descriptorsNamed: 9,
    bottlesNoted: 3,
    hadPrevMonth: true,
    newBottles: 1,
    shelfTotal: 4,
    agreement: 0.5,
    risingWedgeId: "peaty",
    topCategories: [
      { wedgeId: "peaty", sharePct: 46 },
      { wedgeId: "sweet", sharePct: 32 },
      { wedgeId: "fruity", sharePct: 12 },
    ],
    runningLow: [
      { userBottleId: "ub-2", bottleId: "lagavulin-16", name: "Lagavulin 16", fillLevel: 15 },
    ],
    topNoteLeafId: "raisin",
    favoriteBottle: { bottleId: "lagavulin-16", name: "Lagavulin 16", rating: 4.5 },
    totalPours: 5,
    ...overrides,
  };
}

const EMPTY: Partial<DashboardData> = {
  totalPours: 0,
  descriptorsNamed: 0,
  bottlesNoted: 0,
  hadPrevMonth: false,
  agreement: null,
  risingWedgeId: null,
  topCategories: [],
  runningLow: [],
  newBottles: 0,
  shelfTotal: 12,
  topNoteLeafId: null,
  favoriteBottle: null,
};

// Copy that turns the month into a consumption scoreboard or a poem.
const FORBIDDEN = [/pours?\b/i, /\bdrams?\b/i, /\bml\b|\boz\b/i, /streak/i, /blank/i, /writes it/i, /journey/i, /unlock/i, /elevate/i, /—/];

describe("Dashboard", () => {
  it("leads with plain facts about the month: bottles tasted, new bottles, top note", () => {
    render(<Dashboard data={data()} userName="Jordan Rivers" />);
    expect(screen.getByRole("heading", { name: "July" })).toBeInTheDocument();
    expect(screen.getByTestId("month-facts")).toHaveTextContent("3 bottles tasted · 1 new on the shelf · top note:");
    expect(screen.getByText("Peaty / Smoky is up since June.")).toBeInTheDocument();
  });

  it("shows the favourite bottle and flavor highlight, never a pour count or volume", () => {
    const { container } = render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByRole("link", { name: /Lagavulin 16.*4\.5/ })).toHaveAttribute("href", "/bottles/lagavulin-16");
    expect(screen.getByText("46% of your notes")).toBeInTheDocument();
    expect(screen.getByText("50% agree")).toBeInTheDocument();
    for (const re of FORBIDDEN) expect(container.textContent).not.toMatch(re);
    expect(container.textContent).not.toMatch(/[+−]\d/);
  });

  it("monthFacts never mentions pours, volume or a blank page", () => {
    expect(monthFacts(data({ ...EMPTY }))).toBeNull();
    const facts = monthFacts(data({ bottlesNoted: 1, newBottles: 0, topNoteLeafId: null })) ?? "";
    expect(facts).toBe("1 bottle tasted");
    for (const re of FORBIDDEN) expect(facts).not.toMatch(re);
  });

  it("draws flavor bars only when there are several tagged families", () => {
    render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByText("Flavors this month")).toBeInTheDocument();
    expect(screen.getByText("46%")).toBeInTheDocument();
  });

  it("lists running-low bottles by level, with a restock action and no pour prompt", () => {
    const { container } = render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByText("15% left")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Restock/ })).toHaveAttribute("href", "/search?q=Lagavulin%2016");
    expect(screen.queryByRole("button", { name: /Log a pour/ })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/pours? to go/i);
  });

  it("drops the running-low section entirely when nothing is low", () => {
    render(<Dashboard data={data({ runningLow: [] })} userName="Jordan" />);
    expect(screen.queryByText("Running low")).not.toBeInTheDocument();
  });

  it("zero state: one plain line, no tiles, no empty grey bars", () => {
    const { container } = render(<Dashboard data={data(EMPTY)} userName="Jordan" />);
    expect(screen.getByRole("heading", { name: "July · no tastings yet" })).toBeInTheDocument();
    expect(screen.queryByTestId("month-facts")).not.toBeInTheDocument();
    expect(screen.queryByText(/Flavors this month|What you reached for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Favourite|Top flavor|agree/)).not.toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(0);
    for (const re of FORBIDDEN) expect(container.textContent).not.toMatch(re);
  });

  it("a month with only a new bottle still shows the summary, without empty flavor sections", () => {
    render(<Dashboard data={data({ ...EMPTY, newBottles: 2 })} userName="Jordan" />);
    expect(screen.getByTestId("month-facts")).toHaveTextContent("2 new on the shelf");
    expect(screen.queryByText("Flavors this month")).not.toBeInTheDocument();
  });
});
