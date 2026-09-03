// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WHISKEY_CATEGORIES } from "@/db/schema";
import { NewBottleForm } from "./new-bottle-form";

/**
 * Review PLAN-A1. The form is the end of the dead end, so what it must not do
 * matters as much as what it does: it must not demand fields a person holding
 * a bottle can't answer, and it must not quietly add a second row for a bottle
 * the catalog already has.
 */
const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

function mockApi(handler: (body: Record<string, unknown>) => Response) {
  const calls: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push(body);
      return handler(body);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
  refresh.mockReset();
});

function renderForm(overrides: Partial<Parameters<typeof NewBottleForm>[0]> = {}) {
  return render(
    <NewBottleForm
      categories={WHISKEY_CATEGORIES}
      initialName=""
      upc={null}
      source="direct"
      returnTo={null}
      {...overrides}
    />,
  );
}

describe("NewBottleForm", () => {
  it("arrives pre-filled from the miss that sent the user here", () => {
    renderForm({ initialName: "Barrell Dovetail", source: "search" });
    expect(screen.getByLabelText(/bottle name/i)).toHaveValue("Barrell Dovetail");
  });

  it("submits with only a name and a category", async () => {
    const calls = mockApi(() => Response.json({ bottle: { id: "new-1" } }, { status: 201 }));
    const user = userEvent.setup();
    renderForm({ initialName: "Barrell Dovetail" });

    await user.click(screen.getByRole("button", { name: /add this bottle/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ name: "Barrell Dovetail", category: "bourbon" });
    // Distillery, age and ABV are all optional: a form that demands them
    // before it will take a bottle is a dead end in nicer clothes.
    expect(calls[0].distillery).toBeUndefined();
    expect(calls[0].ageYears).toBeUndefined();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/bottles/new-1"));
  });

  it("goes back where it came from when it was sent a return path", async () => {
    mockApi(() => Response.json({ bottle: { id: "new-1" } }, { status: 201 }));
    const user = userEvent.setup();
    renderForm({ initialName: "Barrell Dovetail", returnTo: "/scan" });

    await user.click(screen.getByRole("button", { name: /add this bottle/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/scan"));
  });

  it("shows the near-matches rather than writing a duplicate, and adds on confirmation", async () => {
    const calls = mockApi((body) =>
      body.confirmNew
        ? Response.json({ bottle: { id: "new-1" } }, { status: 201 })
        : Response.json(
            {
              error: "That bottle may already be in the catalog",
              duplicates: [
                {
                  id: "blantons",
                  name: "Blanton's Single Barrel",
                  distillery: "Buffalo Trace",
                  category: "bourbon",
                },
              ],
            },
            { status: 409 },
          ),
    );
    const user = userEvent.setup();
    renderForm({ initialName: "Blantons Single Barrel" });

    await user.click(screen.getByRole("button", { name: /add this bottle/i }));
    await screen.findByText("Blanton's Single Barrel");
    expect(push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /none of these/i }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ confirmNew: true });
  });

  it("says so when the name is too short to be one, without calling the server", async () => {
    const calls = mockApi(() => Response.json({}, { status: 201 }));
    const user = userEvent.setup();
    renderForm({ initialName: "x" });

    await user.click(screen.getByRole("button", { name: /add this bottle/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/give it a name/i);
    expect(calls).toHaveLength(0);
  });

  it("explains what happens to a scanned barcode instead of implying the catalog took it", () => {
    renderForm({ initialName: "Mystery Pick", upc: "012345678905", source: "scan" });
    expect(screen.getByText(/012345678905/)).toBeInTheDocument();
    expect(screen.getByText(/once the bottle is reviewed/i)).toBeInTheDocument();
  });

  it("recovers from a failed request rather than sitting on Adding…", async () => {
    mockApi(() => Response.json({ error: "boom" }, { status: 500 }));
    const user = userEvent.setup();
    renderForm({ initialName: "Barrell Dovetail" });

    await user.click(screen.getByRole("button", { name: /add this bottle/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't add that bottle/i);
    expect(screen.getByRole("button", { name: /add this bottle/i })).toBeEnabled();
  });
});
