// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import {
  BarClient,
  type CalibrationMatrix,
  type FlavorHeatMatrix,
  type PalateHeat,
  type Row,
} from "./bar-client";

afterEach(() => {
  cleanup();
  refresh.mockClear();
});

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

const noCalibration = {
  leaves: {},
  publishedNoteBottles: 0,
  comparedBottles: 0,
  agreement: 0,
  blindSpotIds: [],
  signatureIds: [],
  hasComparison: false,
};

/** Nothing published on any shelf: Label and Compare stay hidden. */
function calibrationMatrix(overrides: Partial<CalibrationMatrix> = {}): CalibrationMatrix {
  return { own: noCalibration, tried: noCalibration, all: noCalibration, ...overrides };
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
  personalFlavorTags: Record<string, number> = {},
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
    personalFlavorTags,
  } as unknown as Row;
}

describe("BarClient flavor map lens", () => {
  it("filters profile-only bottles by a selected flavor family", () => {
    const rows = [
      bottleRow("sweet-row", "Profiled Sweet Bottle", "own", { flavorProfile: { sweet: 8 } }),
      bottleRow("woody-row", "Profiled Woody Bottle", "own", { flavorProfile: { woody: 8 } }),
    ];

    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    fireEvent.click(screen.getByRole("button", { name: "Filter by Sweet" }));
    expect(screen.getByText("Profiled Sweet Bottle")).toBeInTheDocument();
    expect(screen.queryByText("Profiled Woody Bottle")).not.toBeInTheDocument();
  });

  it("offers no lens control until published notes exist to compare against", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    // The old "Producer" chip was permanently visible and permanently empty.
    expect(screen.queryByRole("tab", { name: "Label" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Compare" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Flavor map lens" })).not.toBeInTheDocument();
  });

  it("offers Label once bottles in view carry published notes", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "producer:own": oakHeat })}
        calibration={calibrationMatrix({ own: { ...noCalibration, publishedNoteBottles: 2 } })}
        palate={palate}
      />,
    );

    expect(screen.getByRole("tab", { name: "Label" })).toBeInTheDocument();
    // Published notes alone are not a comparison — that needs notes of your own.
    expect(screen.queryByRole("tab", { name: "Compare" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Label" }));
    expect(screen.getAllByRole("button", { name: "Filter by Oak" }).length).toBeGreaterThan(0);
  });

  it("clears flavor selections when the lens changes", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "producer:own": oakHeat })}
        calibration={calibrationMatrix({ own: { ...noCalibration, publishedNoteBottles: 2 } })}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Filter by Vanilla" })[0]);
    expect(screen.getByLabelText("Active flavor filters")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Label" }));
    expect(screen.queryByLabelText("Active flavor filters")).not.toBeInTheDocument();
  });
});

describe("BarClient collection bar", () => {
  const openFilters = () => fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

  it("swaps the wheel to the new collection's heat and clears the active filter", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "personal:tried": oakHeat })}
        calibration={calibrationMatrix()}
        palate={palate}
      />,
    );

    // My bar opens on the owned shelf, which is sweet-led here.
    fireEvent.click(screen.getAllByRole("button", { name: "Filter by Vanilla" })[0]);
    expect(screen.getByLabelText("Active flavor filters")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Tried/ }));
    expect(screen.queryByLabelText("Active flavor filters")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Filter by Oak" }).length).toBeGreaterThan(0);
  });

  it("gives Tried a flavor map that filters tastings you don't own", () => {
    const rows = [
      bottleRow("owned-row", "Owned Sweet Bottle", "own", { flavorProfile: { sweet: 8 } }),
      bottleRow("oak-row", "Tried Oak Bottle", "tried", { flavorProfile: { woody: 8 } }),
      bottleRow("fruit-row", "Tried Fruity Bottle", "tried", { flavorProfile: { fruity: 8 } }),
    ];

    render(
      <BarClient
        initialRows={rows}
        flavorHeat={heatMatrix({ "personal:tried": oakHeat })}
        calibration={calibrationMatrix()}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Tried/ }));
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

  it("puts Everything and Wishlist in the panel, not the bar", () => {
    const rows = [
      bottleRow("owned-row", "Owned Bottle", "own", {}),
      bottleRow("tried-row", "Tried Bottle", "tried", {}),
    ];
    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    expect(screen.queryByRole("tab", { name: /Everything/ })).not.toBeInTheDocument();

    openFilters();
    fireEvent.click(screen.getByRole("radio", { name: /Everything/ }));
    expect(screen.getByText("Owned Bottle")).toBeInTheDocument();
    expect(screen.getByText("Tried Bottle")).toBeInTheDocument();

    // Neither quick slot may claim to be selected once the panel moves off them.
    for (const name of [/My bar/, /Tried/]) {
      expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "false");
    }
  });

  it("shows no flavor map on the wishlist, which is untasted by definition", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    openFilters();
    fireEvent.click(screen.getByRole("radio", { name: /Wishlist/ }));
    expect(screen.queryByLabelText("Flavor map")).not.toBeInTheDocument();
  });
});

describe("BarClient filter panel", () => {
  const openFilters = () => fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

  const shelf = () => [
    bottleRow("open-cheap", "Open Cheap Bourbon", "own", { category: "bourbon" }, {}),
    bottleRow("sealed-dear", "Sealed Dear Scotch", "own", { category: "scotch-single-malt" }, {}),
    bottleRow("open-dear", "Open Dear Scotch", "own", { category: "scotch-single-malt" }, {}),
  ];

  function renderShelf() {
    const rows = shelf();
    rows[0] = { ...rows[0], status: "open", purchasePrice: 30 } as Row;
    rows[1] = { ...rows[1], status: "sealed", purchasePrice: 120 } as Row;
    rows[2] = { ...rows[2], status: "open", purchasePrice: 120 } as Row;
    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);
  }

  it("ORs options inside a group and ANDs across groups", () => {
    renderShelf();
    openFilters();

    // Bottle: Open — two of the three.
    fireEvent.click(screen.getByRole("checkbox", { name: "Open" }));
    expect(screen.getByText("Open Cheap Bourbon")).toBeInTheDocument();
    expect(screen.getByText("Open Dear Scotch")).toBeInTheDocument();
    expect(screen.queryByText("Sealed Dear Scotch")).not.toBeInTheDocument();

    // AND a second group: open *and* over $100 leaves exactly one.
    fireEvent.click(screen.getByRole("checkbox", { name: "Over $100" }));
    expect(screen.getByText("Open Dear Scotch")).toBeInTheDocument();
    expect(screen.queryByText("Open Cheap Bourbon")).not.toBeInTheDocument();

    // OR within the price group widens it again.
    fireEvent.click(screen.getByRole("checkbox", { name: "Under $50" }));
    expect(screen.getByText("Open Cheap Bourbon")).toBeInTheDocument();
    expect(screen.getByText("Open Dear Scotch")).toBeInTheDocument();
  });

  it("counts what is active and takes it off again from the token", () => {
    renderShelf();
    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Open" }));

    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Remove Open filter" }));
    expect(screen.getByText("Sealed Dear Scotch")).toBeInTheDocument();
  });

  it("drops a wheel selection into the same token row as the rest", () => {
    renderShelf();

    fireEvent.click(screen.getAllByRole("button", { name: "Filter by Vanilla" })[0]);
    expect(
      screen.getByRole("button", { name: "Remove Vanilla filter" }),
    ).toBeInTheDocument();
  });

  it("drops checks that the new collection has no control for", () => {
    const rows = [
      { ...bottleRow("open-row", "Open Bottle", "own", {}), status: "open" } as Row,
      bottleRow("tried-row", "Tried Bottle", "tried", {}),
    ];
    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Open" }));
    expect(screen.getByRole("button", { name: /Filters/ })).toHaveTextContent("1");

    // Tried bottles have no fill state, so "Open" has no control there — and a
    // filter with no visible control would empty the list from nowhere.
    fireEvent.click(screen.getByRole("tab", { name: /Tried/ }));
    expect(screen.getByText("Tried Bottle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filters/ })).not.toHaveTextContent("1");
  });

  it("offers the calibration filters only where published notes exist", () => {
    render(<BarClient initialRows={[bottleRow("plain", "Plain Bottle", "own", {})]}
        flavorHeat={heatMatrix()} calibration={calibrationMatrix()} palate={palate} />);
    openFilters();
    expect(screen.queryByRole("checkbox", { name: /blind spot/i })).not.toBeInTheDocument();

    cleanup();

    const published = bottleRow(
      "published",
      "Published Bottle",
      "own",
      {
        producerFlavorTags: { clove: 2 },
        producerFlavorSourceUrl: "https://example.com/notes",
        producerFlavorSourceLabel: "Distillery tasting notes",
      },
      { cinnamon: 2 },
    );
    render(<BarClient initialRows={[published]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);
    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Has a blind spot" }));
    expect(screen.getByText("Published Bottle")).toBeInTheDocument();
  });
});

describe("BarClient palate as a weighting of Mine", () => {
  it("paints the palate on the same wheel rather than a second chart", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={peatyPalate} />);

    fireEvent.click(screen.getByRole("button", { name: "Weight by rating" }));

    // One wheel on the page, now showing the palate's heat.
    expect(screen.getAllByTestId("bar-flavor-wheel")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Filter by Campfire smoke" }).length).toBeGreaterThan(0);
    expect(screen.getByText("You lean toward")).toBeInTheDocument();
    expect(screen.getByLabelText("Palate leanings")).toHaveTextContent("Peaty / Smoky");
  });

  it("filters the shelf by a flavor tapped on the palate", () => {
    const rows = [
      bottleRow("peaty-row", "Peaty Bottle", "own", { flavorProfile: { peaty: 8 } }),
      bottleRow("sweet-row", "Sweet Bottle", "own", { flavorProfile: { sweet: 8 } }),
    ];

    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={peatyPalate} />);

    fireEvent.click(screen.getByRole("button", { name: "Weight by rating" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter by Peaty / Smoky" }));

    expect(screen.getByText("Peaty Bottle")).toBeInTheDocument();
    expect(screen.queryByText("Sweet Bottle")).not.toBeInTheDocument();
  });

  it("shows the blank-page state before any pours carry a signal", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    fireEvent.click(screen.getByRole("button", { name: "Weight by rating" }));
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
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={cancelled} />);

    fireEvent.click(screen.getByRole("button", { name: "Weight by rating" }));
    expect(screen.queryByText("Your palate is still a blank page")).not.toBeInTheDocument();
    expect(screen.getByTestId("bar-flavor-wheel")).toBeInTheDocument();
  });
});

describe("BarClient compare lens", () => {
  /** The label says clove twice; this drinker wrote cinnamon instead, twice. */
  const cloveCalibration = {
    leaves: {
      vanilla: {
        leafId: "vanilla",
        labelBottles: 2,
        shelfLabelBottles: 2,
        yourBottles: 2,
        sharedBottles: 2,
        bucket: "shared" as const,
        substitutes: [],
      },
      clove: {
        leafId: "clove",
        labelBottles: 2,
        shelfLabelBottles: 2,
        yourBottles: 0,
        sharedBottles: 0,
        bucket: "blind" as const,
        substitutes: [{ leafId: "cinnamon", bottles: 2 }],
      },
      cinnamon: {
        leafId: "cinnamon",
        labelBottles: 0,
        shelfLabelBottles: 0,
        yourBottles: 2,
        sharedBottles: 0,
        bucket: "signature" as const,
        substitutes: [],
      },
    },
    publishedNoteBottles: 2,
    comparedBottles: 2,
    agreement: 0.5,
    blindSpotIds: ["clove"],
    signatureIds: ["cinnamon"],
    hasComparison: true,
  };

  const labelHeat = {
    wedges: { sweet: 1, spicy: 0.8 },
    leaves: { vanilla: 1, clove: 0.8 },
    topWedgeIds: ["sweet", "spicy"],
    hasHeat: true,
  };

  const publishedRow = () =>
    bottleRow(
      "compared-row",
      "Published Bottle",
      "own",
      {
        producerFlavorTags: { clove: 2, vanilla: 2 },
        producerFlavorSourceUrl: "https://example.com/notes",
        producerFlavorSourceLabel: "Distillery tasting notes",
      },
      { cinnamon: 2, vanilla: 2 },
    );

  function renderCompare(rows: Row[] = [publishedRow()]) {
    render(
      <BarClient
        initialRows={rows}
        flavorHeat={heatMatrix({ "producer:own": labelHeat })}
        calibration={calibrationMatrix({ own: cloveCalibration })}
        palate={palate}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
  }

  it("summarises what you catch, miss, and find alone", () => {
    renderCompare();

    const summary = screen.getByLabelText("Calibration summary");
    expect(summary).toHaveTextContent("50%");
    expect(summary).toHaveTextContent("blind spots");
    expect(summary).toHaveTextContent("yours alone");
  });

  it("names each descriptor's bucket for anyone not reading the colours", () => {
    renderCompare();

    expect(screen.getByRole("button", { name: "Filter by Clove, blind spot" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by Vanilla, shared with the label" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by Cinnamon, yours alone" }),
    ).toBeInTheDocument();
  });

  it("answers 'what did I say instead' for a blind spot", () => {
    renderCompare();

    fireEvent.click(screen.getByRole("button", { name: "Filter by Clove, blind spot" }));

    // The whole point: not "you missed clove" but "you call it cinnamon".
    expect(
      screen.getByText(/you wrote Cinnamon instead/i),
    ).toBeInTheDocument();
    // Once in the detail panel, once in the list it just filtered to.
    expect(screen.getAllByText("Published Bottle")).toHaveLength(2);
  });

  it("filters the list by the label's claim, so a blind spot lists its bottles", () => {
    const rows = [
      publishedRow(),
      bottleRow("other-row", "Unmentioned Bottle", "own", {
        producerFlavorTags: { honey: 2 },
        producerFlavorSourceUrl: "https://example.com/notes",
        producerFlavorSourceLabel: "Distillery tasting notes",
      }),
    ];
    renderCompare(rows);

    fireEvent.click(screen.getByRole("button", { name: "Filter by Clove, blind spot" }));
    expect(screen.getAllByText("Published Bottle").length).toBeGreaterThan(0);
    expect(screen.queryByText("Unmentioned Bottle")).not.toBeInTheDocument();
  });

  it("falls back to Mine when the shelf in view has nothing to compare", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "producer:own": labelHeat })}
        calibration={calibrationMatrix({ own: cloveCalibration })}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(screen.getByLabelText("Calibration summary")).toBeInTheDocument();

    // The tried shelf has no published notes, so Compare cannot describe it.
    fireEvent.click(screen.getByRole("tab", { name: /Tried/ }));
    expect(screen.queryByLabelText("Calibration summary")).not.toBeInTheDocument();
  });
});

describe("BarClient filter correctness", () => {
  const openFilters = () => fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

  const publishedRow = (
    id: string,
    name: string,
    producer: Record<string, number>,
    mine: Record<string, number>,
  ) =>
    bottleRow(
      id,
      name,
      "own",
      {
        producerFlavorTags: producer,
        producerFlavorSourceUrl: "https://example.com/notes",
        producerFlavorSourceLabel: "Distillery tasting notes",
      },
      mine,
    );

  it("calls a descriptor a blind spot wherever the comparison does", () => {
    // Two labels say clove; this drinker caught it once. A 50% hit rate is a
    // blind spot to getFlavorCalibration, so the filter has to agree — testing
    // "never tagged anywhere" would drop both bottles and contradict the
    // Compare summary sitting directly above it.
    const rows = [
      publishedRow("caught", "Caught Clove", { clove: 2 }, { clove: 2 }),
      publishedRow("missed", "Missed Clove", { clove: 2 }, { cinnamon: 2 }),
    ];
    const cloveIsBlind = {
      ...noCalibration,
      leaves: {
        clove: {
          leafId: "clove",
          labelBottles: 2,
          shelfLabelBottles: 2,
          yourBottles: 1,
          sharedBottles: 1,
          bucket: "blind" as const,
          substitutes: [{ leafId: "cinnamon", bottles: 1 }],
        },
      },
      publishedNoteBottles: 2,
      comparedBottles: 2,
      agreement: 0.5,
      blindSpotIds: ["clove"],
      hasComparison: true,
    };

    render(
      <BarClient
        initialRows={rows}
        flavorHeat={heatMatrix()}
        calibration={calibrationMatrix({ own: cloveIsBlind })}
        palate={palate}
      />,
    );

    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Has a blind spot" }));
    expect(screen.getByText("Caught Clove")).toBeInTheDocument();
    expect(screen.getByText("Missed Clove")).toBeInTheDocument();
  });

  it("still catches a descriptor the comparison has never seen", () => {
    // An owned bottle whose label names something never tagged anywhere: no
    // comparison covers it, so the fallback has to surface it.
    const rows = [publishedRow("untasted", "Untasted Bottle", { nutmeg: 2 }, {})];
    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Has a blind spot" }));
    expect(screen.getByText("Untasted Bottle")).toBeInTheDocument();
  });

  it("does not resurrect a check dropped by a collection change", () => {
    const rows = [
      { ...bottleRow("open-row", "Open Bottle", "own", {}), status: "open" } as Row,
      { ...bottleRow("sealed-row", "Sealed Bottle", "own", {}), status: "sealed" } as Row,
      bottleRow("tried-row", "Tried Bottle", "tried", {}),
    ];
    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Open" }));
    expect(screen.queryByText("Sealed Bottle")).not.toBeInTheDocument();

    // Tried bottles have no fill state, so "Open" has no control there.
    fireEvent.click(screen.getByRole("tab", { name: /Tried/ }));
    fireEvent.click(screen.getByRole("tab", { name: /My bar/ }));

    // Coming back must not reinstate a filter the UI said was gone.
    expect(screen.getByText("Sealed Bottle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filters/ })).not.toHaveTextContent("1");
  });

  it("says the filters are too narrow rather than that the shelf is empty", () => {
    const rows = [
      { ...bottleRow("sealed-row", "Sealed Bottle", "own", {}), status: "sealed" } as Row,
    ];
    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Open" }));

    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
    // "Your shelf is waiting" would be a lie: there is a bottle on it.
    expect(screen.queryByText("Your shelf is waiting")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Sealed Bottle")).toBeInTheDocument();
  });

  it("still shows the empty-shelf state when the collection really is empty", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    expect(screen.getByText("Your shelf is waiting")).toBeInTheDocument();
    expect(screen.queryByText("Nothing matches")).not.toBeInTheDocument();
  });
});

describe("BarClient lens across collections", () => {
  const labelHeat = {
    wedges: { sweet: 1 },
    leaves: { vanilla: 1 },
    topWedgeIds: ["sweet"],
    hasHeat: true,
  };
  const comparable = {
    ...noCalibration,
    leaves: {
      vanilla: {
        leafId: "vanilla",
        labelBottles: 1,
        shelfLabelBottles: 1,
        yourBottles: 1,
        sharedBottles: 1,
        bucket: "shared" as const,
        substitutes: [],
      },
    },
    publishedNoteBottles: 1,
    comparedBottles: 1,
    agreement: 1,
    hasComparison: true,
  };

  it("does not resurrect a lens the shelf you left could not support", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "producer:own": labelHeat })}
        calibration={calibrationMatrix({ own: comparable })}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(screen.getByRole("tab", { name: "Compare" })).toHaveAttribute("aria-selected", "true");

    // Tried has no published notes, so Compare is not offered there and the
    // control shows Mine as selected.
    fireEvent.click(screen.getByRole("tab", { name: /Tried/ }));
    expect(screen.queryByRole("tab", { name: "Compare" })).not.toBeInTheDocument();

    // Coming back must not contradict what that screen said was selected.
    fireEvent.click(screen.getByRole("tab", { name: /My bar/ }));
    expect(screen.getByRole("tab", { name: "Compare" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Mine" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps a lens the new collection can still support", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "producer:own": labelHeat, "producer:all": labelHeat })}
        calibration={calibrationMatrix({ own: comparable, all: comparable })}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Everything/ }));

    expect(screen.getByRole("tab", { name: "Compare" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("BarClient filter/summary agreement", () => {
  const openFilters = () => fireEvent.click(screen.getByRole("button", { name: /Filters/ }));

  const publishedRow = (
    id: string,
    name: string,
    producer: Record<string, number>,
    mine: Record<string, number>,
  ) =>
    bottleRow(
      id,
      name,
      "own",
      {
        producerFlavorTags: producer,
        producerFlavorSourceUrl: "https://example.com/notes",
        producerFlavorSourceLabel: "Distillery tasting notes",
      },
      mine,
    );

  it("won't call a descriptor yours alone when some label names it", () => {
    // Bottle A's label says cinnamon; you tag cinnamon only on B. Across the
    // shelf that is a *blind* spot — a label mention with no shared mention —
    // so B must not come back as "a note of your own" while the wheel and the
    // summary are calling cinnamon a blind spot.
    const rows = [
      publishedRow("a", "Labelled Cinnamon", { cinnamon: 2 }, { vanilla: 2 }),
      publishedRow("b", "Yours Cinnamon", { vanilla: 2 }, { cinnamon: 2 }),
    ];
    const cinnamonIsBlind = {
      ...noCalibration,
      leaves: {
        cinnamon: {
          leafId: "cinnamon",
          labelBottles: 1,
          shelfLabelBottles: 1,
          yourBottles: 1,
          sharedBottles: 0,
          bucket: "blind" as const,
          substitutes: [],
        },
        vanilla: {
          leafId: "vanilla",
          labelBottles: 1,
          shelfLabelBottles: 1,
          yourBottles: 1,
          sharedBottles: 1,
          bucket: "shared" as const,
          substitutes: [],
        },
      },
      publishedNoteBottles: 2,
      comparedBottles: 2,
      agreement: 0.5,
      blindSpotIds: ["cinnamon"],
      hasComparison: true,
    };

    render(
      <BarClient
        initialRows={rows}
        flavorHeat={heatMatrix()}
        calibration={calibrationMatrix({ own: cinnamonIsBlind })}
        palate={palate}
      />,
    );

    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Has a note of your own" }));
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
  });

  it("returns the bottle whose descriptor no label anywhere names", () => {
    const rows = [publishedRow("a", "Truly Yours", { vanilla: 2 }, { chocolate: 2 })];
    const chocolateIsSignature = {
      ...noCalibration,
      leaves: {
        chocolate: {
          leafId: "chocolate",
          labelBottles: 0,
          shelfLabelBottles: 0,
          yourBottles: 1,
          sharedBottles: 0,
          bucket: "signature" as const,
          substitutes: [],
        },
      },
      publishedNoteBottles: 1,
      comparedBottles: 1,
      signatureIds: ["chocolate"],
      hasComparison: true,
    };

    render(
      <BarClient
        initialRows={rows}
        flavorHeat={heatMatrix()}
        calibration={calibrationMatrix({ own: chocolateIsSignature })}
        palate={palate}
      />,
    );

    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Has a note of your own" }));
    expect(screen.getByText("Truly Yours")).toBeInTheDocument();
  });
});

describe("BarClient keeps server-derived data honest", () => {
  it("refetches after removing a bottle, so Compare stops counting it", async () => {
    const rows = [
      { ...bottleRow("gone", "Doomed Bottle", "own", {}), status: "open" } as Row,
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    fireEvent.click(screen.getByRole("button", { name: /Doomed Bottle/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // The flavor heat and calibration are computed server-side over the whole
    // shelf, so dropping the row locally is not enough.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});

describe("BarClient analytics-first layout", () => {
  it("reads stats and flavor map above the bottle list, with no Insights zone", () => {
    const rows = [bottleRow("owned-row", "Owned Bottle", "own", {})];
    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    // Analytics lead the page again: the map is primary content, not a demoted
    // "Insights" appendix under the shelf.
    const map = screen.getByRole("region", { name: "Flavor map" });
    const bottle = screen.getByText("Owned Bottle");
    expect(map.compareDocumentPosition(bottle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Insights" })).not.toBeInTheDocument();

    // The stats strip stays above the map.
    const stats = screen.getByRole("region", { name: "Bar stats" });
    expect(stats.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows one slim stats strip on the own shelf only — the sole money surface", () => {
    const rows = [
      { ...bottleRow("owned-row", "Owned Bottle", "own", {}), purchasePrice: 50 } as Row,
      bottleRow("tried-row", "Tried Bottle", "tried", {}),
    ];
    render(<BarClient initialRows={rows} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    const stats = screen.getByRole("region", { name: "Bar stats" });
    expect(stats).toHaveTextContent("spent");
    expect(stats).toHaveTextContent("est. value");

    // Money never describes bottles that are not the owner's own collection.
    fireEvent.click(screen.getByRole("tab", { name: /Tried/ }));
    expect(screen.queryByRole("region", { name: "Bar stats" })).not.toBeInTheDocument();
  });

  it("hosts no recommendation rails — both moved to Home", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    expect(screen.queryByRole("heading", { name: "For your palate" })).not.toBeInTheDocument();
    expect(screen.queryByText(/pour tonight/i)).not.toBeInTheDocument();
  });

  it("offers the tour as a quiet fourth rung of the empty own shelf", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    expect(screen.getByRole("link", { name: /take the tour/i })).toHaveAttribute(
      "href",
      "/welcome",
    );
  });
});

describe("BarClient descriptor detail copy", () => {
  it("explains a blind spot that only an unpoured label names", () => {
    // Cinnamon is blind because a label names it — on a bottle never poured.
    // Quoting the comparison count here would read "on 0 bottles", which
    // contradicts the very reason it is blind.
    const rows = [
      bottleRow(
        "unpoured",
        "Unpoured Bottle",
        "own",
        {
          producerFlavorTags: { cinnamon: 2 },
          producerFlavorSourceUrl: "https://example.com/notes",
          producerFlavorSourceLabel: "Distillery tasting notes",
        },
        {},
      ),
    ];
    const cinnamonOnlyOnAnUnpouredLabel = {
      ...noCalibration,
      leaves: {
        cinnamon: {
          leafId: "cinnamon",
          labelBottles: 0,
          shelfLabelBottles: 1,
          yourBottles: 1,
          sharedBottles: 0,
          bucket: "blind" as const,
          substitutes: [],
        },
      },
      publishedNoteBottles: 2,
      comparedBottles: 1,
      blindSpotIds: ["cinnamon"],
      hasComparison: true,
    };

    render(
      <BarClient
        initialRows={rows}
        flavorHeat={heatMatrix({
          "producer:own": {
            wedges: { spicy: 1 },
            leaves: { cinnamon: 1 },
            topWedgeIds: ["spicy"],
            hasHeat: true,
          },
        })}
        calibration={calibrationMatrix({ own: cinnamonOnlyOnAnUnpouredLabel })}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    fireEvent.click(screen.getByRole("button", { name: /Filter by Cinnamon/ }));

    expect(screen.getByText(/haven’t poured yet/)).toBeInTheDocument();
    expect(screen.queryByText(/on 0 bottles/)).not.toBeInTheDocument();
  });
});
