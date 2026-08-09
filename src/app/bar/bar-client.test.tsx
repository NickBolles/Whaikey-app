// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  BarClient,
  type CalibrationMatrix,
  type FlavorHeatMatrix,
  type PalateHeat,
  type Row,
} from "./bar-client";

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

describe("BarClient flavor map scope", () => {
  it("swaps the wheel to the scope's heat and clears the active filter", () => {
    render(
      <BarClient
        initialRows={[]}
        flavorHeat={heatMatrix({ "personal:tried": oakHeat })}
        calibration={calibrationMatrix()}
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
        calibration={calibrationMatrix()}
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
        calibration={calibrationMatrix()}
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
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={palate} />);

    fireEvent.click(screen.getByRole("tab", { name: "Wishlist" }));
    expect(screen.queryByLabelText("Flavor map")).not.toBeInTheDocument();
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

  it("hides the shelf scope, which does not apply to a drinker", () => {
    render(<BarClient initialRows={[]} flavorHeat={heatMatrix()}
        calibration={calibrationMatrix()} palate={peatyPalate} />);

    expect(screen.getByRole("tab", { name: "On my shelf" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Weight by rating" }));
    expect(screen.queryByRole("tab", { name: "On my shelf" })).not.toBeInTheDocument();

    // Switching back restores it.
    fireEvent.click(screen.getByRole("button", { name: "Weight by rating" }));
    expect(screen.getByRole("tab", { name: "On my shelf" })).toBeInTheDocument();
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
        yourBottles: 2,
        sharedBottles: 2,
        bucket: "shared" as const,
        substitutes: [],
      },
      clove: {
        leafId: "clove",
        labelBottles: 2,
        yourBottles: 0,
        sharedBottles: 0,
        bucket: "blind" as const,
        substitutes: [{ leafId: "cinnamon", bottles: 2 }],
      },
      cinnamon: {
        leafId: "cinnamon",
        labelBottles: 0,
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
    fireEvent.click(screen.getByRole("tab", { name: "Only tasted" }));
    expect(screen.queryByLabelText("Calibration summary")).not.toBeInTheDocument();
  });
});
