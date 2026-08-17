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
    totalPours: 5,
    ...overrides,
  };
}

describe("Dashboard", () => {
  it("headlines the month with a palate fact, not a pour count", () => {
    render(<Dashboard data={data()} userName="Jordan Rivers" />);
    expect(screen.getByText("JULY")).toBeInTheDocument();
    expect(
      screen.getByText("Peaty / Smoky rose the most on your palate since June."),
    ).toBeInTheDocument();
  });

  it("measures the month in descriptor breadth, never in pours or a delta", () => {
    const { container } = render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("flavors named")).toBeInTheDocument();
    expect(screen.getByText("across 3 bottles")).toBeInTheDocument();
    expect(screen.getByText("4 on the shelf")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("with the label")).toBeInTheDocument();

    // Guardrail: nothing frames pouring more as progress (AGENTS.md).
    expect(container.textContent).not.toMatch(/pours? this month/i);
    expect(container.textContent).not.toMatch(/vs June/);
    expect(container.textContent).not.toMatch(/[+−]\d/);
  });

  it("draws the reached-for categories with right-aligned percentages", () => {
    render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByText("46%")).toBeInTheDocument();
    expect(screen.getByText("Peaty / Smoky")).toBeInTheDocument();
  });

  it("lists running-low bottles by level, with a restock action and no pour prompt", () => {
    const { container } = render(<Dashboard data={data()} userName="Jordan" />);
    expect(screen.getByText("Lagavulin 16")).toBeInTheDocument();
    expect(screen.getByText("15% left")).toBeInTheDocument();

    // Restocking is inventory; a Pour CTA here would be a finish-the-bottle nudge.
    expect(screen.getByRole("link", { name: /Restock/ })).toHaveAttribute(
      "href",
      "/search?q=Lagavulin%2016",
    );
    expect(screen.queryByRole("button", { name: /Log a pour/ })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/pours? to go/i);
  });

  it("renders the greyed skeleton — never hides — under 3 lifetime pours", () => {
    render(
      <Dashboard
        data={data({
          totalPours: 0,
          descriptorsNamed: 0,
          bottlesNoted: 0,
          hadPrevMonth: false,
          agreement: null,
          risingWedgeId: null,
          topCategories: [],
          runningLow: [],
          newBottles: 0,
          shelfTotal: 0,
        })}
        userName="Jordan"
      />,
    );
    // Same skeleton, same order: header, tiles, tracks, plus the unlock card.
    expect(screen.getByText(/still blank — the first note writes it/)).toBeInTheDocument();
    expect(screen.getByText("What you reached for")).toBeInTheDocument();
    expect(screen.getByText("Running low")).toBeInTheDocument();
    expect(screen.getByText("One note fills this in")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Scan a bottle/ })).toHaveAttribute("href", "/scan");
    expect(screen.getByText("needs tagged pours")).toBeInTheDocument();
    // The unlock card explains what tagging reveals, never "finish this bottle".
    expect(screen.queryByText(/rescuing/i)).not.toBeInTheDocument();
  });
});
