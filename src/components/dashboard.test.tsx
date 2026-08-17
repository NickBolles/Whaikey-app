// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DashboardData } from "@/lib/dashboard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { Dashboard } from "./dashboard";

afterEach(cleanup);

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    monthName: "July",
    prevMonthName: "June",
    pourCount: 4,
    pourDelta: 3,
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
      { userBottleId: "ub-2", bottleId: "lagavulin-16", name: "Lagavulin 16", fillLevel: 15, poursLeft: 2 },
    ],
    totalPours: 5,
    ...overrides,
  };
}

describe("Dashboard", () => {
  it("headlines the month with its most notable fact", () => {
    render(<Dashboard data={data()} userName="Jordan Rivers" />);
    expect(screen.getByText("JULY")).toBeInTheDocument();
    expect(
      screen.getByText("4 pours this month, and Peaty / Smoky rose the most since June."),
    ).toBeInTheDocument();
  });

  it("shows the three stat tiles with their deltas and sources named", () => {
    render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByText("+3 vs June")).toBeInTheDocument();
    expect(screen.getByText("4 on the shelf")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("with the label")).toBeInTheDocument();
  });

  it("draws the reached-for categories with right-aligned percentages", () => {
    render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByText("46%")).toBeInTheDocument();
    expect(screen.getByText("Peaty / Smoky")).toBeInTheDocument();
  });

  it("lists running-low bottles with remaining and estimated pours left", () => {
    render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByText("Lagavulin 16")).toBeInTheDocument();
    expect(screen.getByText(/15% left · ~2 pours to go/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log a pour of Lagavulin 16" })).toBeInTheDocument();
  });

  it("renders the greyed skeleton — never hides — under 3 lifetime pours", () => {
    render(
      <Dashboard
        data={data({
          totalPours: 0,
          pourCount: 0,
          hadPrevMonth: false,
          agreement: null,
          risingWedgeId: null,
          topCategories: [],
          runningLow: [],
          newBottles: 0,
          shelfTotal: 0,
          pourDelta: 0,
        })}
        userName="Jordan"
      />,
    );
    // Same skeleton, same order: header, tiles, tracks, plus the unlock card.
    expect(screen.getByText(/still blank — the first dram writes it/)).toBeInTheDocument();
    expect(screen.getByText("What you reached for")).toBeInTheDocument();
    expect(screen.getByText("Running low")).toBeInTheDocument();
    expect(screen.getByText("One dram fills this in")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Scan a bottle/ })).toHaveAttribute("href", "/scan");
    expect(screen.getByText("needs tagged pours")).toBeInTheDocument();
  });
});
