// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BarClient, type FlavorHeatMatrix, type PalateHeat, type Row } from "./bar-client";

afterEach(cleanup);

const sweetHeat = {
  wedges: { sweet: 1 },
  leaves: { vanilla: 1 },
  topWedgeIds: ["sweet"],
  hasHeat: true,
};

const oakHeat = {
  wedges: { woody: 1 },
  leaves: { oak: 1 },
  topWedgeIds: ["woody"],
  hasHeat: true,
};

const emptyHeat = {
  wedges: {},
  leaves: {},
  topWedgeIds: [],
  hasHeat: false,
};

/** Every (source, scope) pair, so the client can switch either axis freely. */
function heatMatrix(overrides: Partial<FlavorHeatMatrix> = {}): FlavorHeatMatrix {
  return {
    "personal:own": sweetHeat,
    "personal:tried": emptyHeat,
    "personal:all": sweetHeat,
    "producer:own": emptyHeat,
    "producer:tried": emptyHeat,
    "producer:all": emptyHeat,
    ...overrides,
  };
}

/** No pours yet: the palate source shows its blank-page state. */
const palate: PalateHeat = { wedges: {}, leaves: {}, topWedgeIds: [], sampleSize: 0 };

/** A drinker whose ratings lean peaty, with campfire the strongest descriptor. */
const peatyPalate: PalateHeat = {
  wedges: { peaty: 1, sweet: 0.4 },
  leaves: { campfire: 1, vanilla: 0.4 },
  topWedgeIds: ["peaty", "sweet"],
  sampleSize: 6,
};

function bottleRow(
  id: string,
  name: string,
  relationship: string,
  bottle: Record<string, unknown>,
): Row {
  return {
    id,
    relationship,
    quantity: 1,
    status: relationship === "own" ? "sealed" : null,
    fillLevel: relationship === "own" ? 100 : null,
    bottle: {
      id: `${id}-bottle`,
      name,
      category: "bourbon",
      distilleryName: null,
      avgPrice: null,
      flavorProfile: null,
      producerFlavorTags: null,
      producerFlavorSourceUrl: null,
      producerFlavorSourceLabel: null,
      ...bottle,
    },
    personalFlavorTags: {},
  } as unknown as Row;
}

describe("BarClient flavor source controls", () => {
  it("filters profile-only bottles by a selected flavor family", () => {
    const rows = [
      bottleRow("sweet-row", "Profiled Sweet Bottle", "own", { flavorProfile: { sweet: 8 } }),
      bottleRow("woody-row", "Profiled Woody Bottle", "own", { flavorProfile: { woody: 8 } }),
    ];

    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()} palate={palate} />);

    fireEvent.click(screen.getByRole("button", { name: "Filter by Sweet" }));
    expect(screen.getByText("Profiled Sweet Bottle")).toBeInTheDocument();
    expect(screen.queryByText("Profiled Woody Bottle")).not.toBeInTheDocument();
  });

  it("clears selected personal filters when switching to an empty producer source", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()} palate={palate} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Filter by Vanilla" })[0]);
    expect(screen.getByLabelText("Active flavor filters")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Producer" }));
    expect(screen.queryByLabelText("Active flavor filters")).not.toBeInTheDocument();
    expect(screen.getByText("No producer flavor notes yet")).toBeInTheDocument();
  });
});

describe("BarClient flavor map scope", () => {
  it("swaps the wheel to the scope's heat and clears the active filter", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "personal:tried": oakHeat })}
        palate={palate}
      />,
    );

    // My Bar opens on the owned scope, which is sweet-led here.
    fireEvent.click(screen.getAllByRole("button", { name: "Filter by Vanilla" })[0]);
    expect(screen.getByLabelText("Active flavor filters")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Tried" }));
    expect(screen.queryByLabelText("Active flavor filters")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Filter by Oak" }).length).toBeGreaterThan(0);
  });

  it("gives the Tried tab a flavor map that filters tastings you don't own", () => {
    const rows = [
      bottleRow("owned-row", "Owned Sweet Bottle", "own", { flavorProfile: { sweet: 8 } }),
      bottleRow("oak-row", "Tried Oak Bottle", "tried", { flavorProfile: { woody: 8 } }),
      bottleRow("fruit-row", "Tried Fruity Bottle", "tried", { flavorProfile: { fruity: 8 } }),
    ];

    render(
      <BarClient
        initialRows={rows}
        flavorHeat={heatMatrix({ "personal:tried": oakHeat })}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Tried" }));
    expect(screen.getByText("Tried Oak Bottle")).toBeInTheDocument();
    expect(screen.getByText("Tried Fruity Bottle")).toBeInTheDocument();

    // The question this whole feature exists to answer: which of the bottles
    // I've tried are oak-forward?
    fireEvent.click(screen.getByRole("button", { name: "Filter by Woody" }));
    expect(screen.getByText("Tried Oak Bottle")).toBeInTheDocument();
    expect(screen.queryByText("Tried Fruity Bottle")).not.toBeInTheDocument();
    expect(screen.queryByText("Owned Sweet Bottle")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 2 tastings")).toBeInTheDocument();
  });

  it("keeps an explicit Everything scope across tab changes", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "personal:all": oakHeat })}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Everything" }));
    fireEvent.click(screen.getByRole("tab", { name: "Tried" }));
    expect(screen.getByRole("tab", { name: "Everything" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows no flavor map on the wishlist, which is untasted by definition", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()} palate={palate} />);

    fireEvent.click(screen.getByRole("tab", { name: "Wishlist" }));
    expect(screen.queryByLabelText("Flavor map")).not.toBeInTheDocument();
  });
});

describe("BarClient palate on the unified wheel", () => {
  it("paints the palate on the same wheel rather than a second chart", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()} palate={peatyPalate} />);

    fireEvent.click(screen.getByRole("tab", { name: "My palate" }));

    // One wheel on the page, now showing the palate's heat.
    expect(screen.getAllByTestId("bar-flavor-wheel")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Filter by Campfire smoke" }).length).toBeGreaterThan(0);
    expect(screen.getByText("You lean toward")).toBeInTheDocument();
    expect(screen.getByLabelText("Palate leanings")).toHaveTextContent("Peaty / Smoky");
  });

  it("hides the shelf scope, which does not apply to a drinker", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()} palate={peatyPalate} />);

    expect(screen.getByRole("tab", { name: "On my shelf" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "My palate" }));
    expect(screen.queryByRole("tab", { name: "On my shelf" })).not.toBeInTheDocument();

    // Switching back restores it.
    fireEvent.click(screen.getByRole("tab", { name: "My notes" }));
    expect(screen.getByRole("tab", { name: "On my shelf" })).toBeInTheDocument();
  });

  it("filters the shelf by a flavor tapped on the palate", () => {
    const rows = [
      bottleRow("peaty-row", "Peaty Bottle", "own", { flavorProfile: { peaty: 8 } }),
      bottleRow("sweet-row", "Sweet Bottle", "own", { flavorProfile: { sweet: 8 } }),
    ];

    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()} palate={peatyPalate} />);

    fireEvent.click(screen.getByRole("tab", { name: "My palate" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter by Peaty / Smoky" }));

    expect(screen.getByText("Peaty Bottle")).toBeInTheDocument();
    expect(screen.queryByText("Sweet Bottle")).not.toBeInTheDocument();
  });

  it("shows the blank-page state before any pours carry a signal", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()} palate={palate} />);

    fireEvent.click(screen.getByRole("tab", { name: "My palate" }));
    expect(screen.getByText("Your palate is still a blank page")).toBeInTheDocument();
    expect(screen.queryByTestId("bar-flavor-wheel")).not.toBeInTheDocument();
  });

  it("still draws when a descriptor is liked but its family cancelled out", () => {
    // A loved campfire pour and a hated brine one both land in Peaty, so the
    // wedge nets to zero while campfire stays positive. That is a preference we
    // know about, not a blank page.
    const cancelled: PalateHeat = {
      wedges: {},
      leaves: { campfire: 1 },
      topWedgeIds: [],
      sampleSize: 2,
    };
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()} palate={cancelled} />);

    fireEvent.click(screen.getByRole("tab", { name: "My palate" }));
    expect(screen.queryByText("Your palate is still a blank page")).not.toBeInTheDocument();
    expect(screen.getByTestId("bar-flavor-wheel")).toBeInTheDocument();
  });
});
