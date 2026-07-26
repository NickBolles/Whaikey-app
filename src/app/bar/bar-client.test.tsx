// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BarClient, type Row } from "./bar-client";

afterEach(cleanup);

const personalFlavorHeat = {
  wedges: { sweet: 1 },
  leaves: { vanilla: 1 },
  topWedgeIds: ["sweet"],
  hasHeat: true,
};

const producerFlavorHeat = {
  wedges: {},
  leaves: {},
  topWedgeIds: [],
  hasHeat: false,
};

const palate = { vector: {}, sampleSize: 0 };

describe("BarClient flavor source controls", () => {
  it("filters profile-only bottles by a selected flavor family", () => {
    const rows = [
      {
        id: "sweet-row",
        relationship: "own",
        quantity: 1,
        status: "sealed",
        fillLevel: 100,
        bottle: {
          id: "sweet-bottle",
          name: "Profiled Sweet Bottle",
          category: "bourbon",
          distilleryName: null,
          avgPrice: null,
          flavorProfile: { sweet: 8 },
          producerFlavorTags: null,
          producerFlavorSourceUrl: null,
          producerFlavorSourceLabel: null,
        },
        personalFlavorTags: {},
      },
      {
        id: "woody-row",
        relationship: "own",
        quantity: 1,
        status: "sealed",
        fillLevel: 100,
        bottle: {
          id: "woody-bottle",
          name: "Profiled Woody Bottle",
          category: "bourbon",
          distilleryName: null,
          avgPrice: null,
          flavorProfile: { woody: 8 },
          producerFlavorTags: null,
          producerFlavorSourceUrl: null,
          producerFlavorSourceLabel: null,
        },
        personalFlavorTags: {},
      },
    ] as unknown as Row[];

    render(
      <BarClient
        initialRows={rows}
        personalFlavorHeat={personalFlavorHeat}
        producerFlavorHeat={producerFlavorHeat}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Filter by Sweet" }));
    expect(screen.getByText("Profiled Sweet Bottle")).toBeInTheDocument();
    expect(screen.queryByText("Profiled Woody Bottle")).not.toBeInTheDocument();
  });

  it("clears selected personal filters when switching to an empty producer source", () => {
    render(
      <BarClient
        initialRows={[]}
        personalFlavorHeat={personalFlavorHeat}
        producerFlavorHeat={producerFlavorHeat}
        palate={palate}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Filter by Vanilla" })[0]);
    expect(screen.getByLabelText("Active flavor filters")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Producer Notes" }));
    expect(screen.queryByLabelText("Active flavor filters")).not.toBeInTheDocument();
    expect(screen.getByText("No producer flavor notes yet")).toBeInTheDocument();
  });
});
