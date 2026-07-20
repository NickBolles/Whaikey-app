// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportClient } from "./import-client";

const CSV = ["Bottle,UPC,Price Paid", "Eagle Rare 10,080244002145,39.99", "Stagg,,99.99"].join("\n");

const EAGLE = { id: "eagle-rare-10", name: "Eagle Rare 10 Year", distillery: "Buffalo Trace", category: "bourbon", via: "upc" as const };
const STAGG = { id: "stagg", name: "Stagg", distillery: "Buffalo Trace", category: "bourbon", via: "name" as const };

function mockApi() {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes("/api/import/analyze"))
        return Response.json({
          mapping: {
            name: 0, upc: 1, purchasePrice: 2, relationship: null, status: null,
            fillLevel: null, quantity: null, purchaseDate: null, store: null,
            location: null, notes: null,
          },
          source: "ai",
        });
      if (url.includes("/api/import/match"))
        return Response.json({ results: [{ candidates: [EAGLE] }, { candidates: [STAGG] }] });
      if (url.includes("/api/import/commit"))
        return Response.json({ added: 2, updated: 0, upcsTaught: 1, skipped: 0 });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ImportClient", () => {
  it("walks paste → mapping → match → commit and reports the summary", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    render(<ImportClient />);

    await user.click(screen.getByLabelText(/paste csv/i));
    await user.paste(CSV);
    await user.click(screen.getByRole("button", { name: /continue/i }));

    // Mapping step: AI proposal shown, editable per field.
    expect(await screen.findByText(/ai suggested/i)).toBeTruthy();
    const nameSelect = screen.getByLabelText("Bottle name") as HTMLSelectElement;
    expect(nameSelect.value).toBe("0");

    await user.click(screen.getByRole("button", { name: /match 2 rows/i }));

    // Match step: both rows preselected with their top candidate.
    expect(await screen.findByText(/confirm matches \(2\/2\)/i)).toBeTruthy();
    expect(screen.getByText(/via upc/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /import 2 bottles/i }));

    expect(await screen.findByText(/collection imported/i)).toBeTruthy();
    expect(screen.getByText(/2 added, 0 updated, 1 barcode learned/i)).toBeTruthy();

    const commit = calls.find((c) => c.url.includes("/api/import/commit"));
    const items = (commit?.body as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      bottleId: EAGLE.id,
      relationship: "own",
      purchasePrice: 39.99,
      upc: "080244002145",
    });
    expect(items[1]).toMatchObject({ bottleId: STAGG.id, purchasePrice: 99.99 });
  });

  it("lets a row be skipped and requires at least one match", async () => {
    mockApi();
    const user = userEvent.setup();
    render(<ImportClient />);

    await user.click(screen.getByLabelText(/paste csv/i));
    await user.paste(CSV);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.click(await screen.findByRole("button", { name: /match 2 rows/i }));
    await screen.findByText(/confirm matches \(2\/2\)/i);

    await user.selectOptions(screen.getByLabelText(/match for eagle rare 10$/i), "");
    expect(screen.getByText(/confirm matches \(1\/2\)/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /import 1 bottle$/i })).toBeTruthy();
  });

  it("surfaces a parse error for junk input", async () => {
    mockApi();
    const user = userEvent.setup();
    render(<ImportClient />);

    await user.click(screen.getByLabelText(/paste csv/i));
    await user.paste("just-a-header-no-rows");
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/header row plus at least one data row/i);
  });
});
