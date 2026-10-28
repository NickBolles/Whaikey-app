// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { isUngatedPath } from "@/lib/age-gate";
import SourcesPage from "./page";

afterEach(cleanup);

describe("/sources", () => {
  it("carries the attribution notices the open licences ask for", () => {
    render(<SourcesPage />);
    expect(screen.getByText(/Contains data from the State of Iowa, licensed under CC BY 4.0/)).toBeTruthy();
    expect(screen.getByText(/Open Government Licence – British Columbia\./)).toBeTruthy();
    expect(screen.getByText(/made available under the Open Database Licence \(ODbL\)/)).toBeTruthy();
  });

  it("says the open data underneath is not ours to restrict", () => {
    render(<SourcesPage />);
    expect(screen.getByText(/Nothing in our Terms\s+limits what an open licence lets you do/)).toBeTruthy();
  });

  it("credits producer logos by their Commons licence, and only CC BY marks on the bottle page", () => {
    render(<SourcesPage />);
    expect(screen.getByRole("link", { name: "Wikimedia Commons" }).getAttribute("href")).toBe(
      "https://commons.wikimedia.org/",
    );
    expect(screen.getByText(/appear only on a bottle.s page, with the file.s author and licence/)).toBeTruthy();
    expect(screen.getByText(/doesn.t mean that producer endorses/)).toBeTruthy();
  });

  it("is readable without passing the age gate, like the policies it is linked from", () => {
    expect(isUngatedPath("/sources")).toBe(true);
  });
});
