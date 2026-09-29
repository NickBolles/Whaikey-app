// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const disablePush = vi.fn();
vi.mock("@/lib/native/push", () => ({ disablePush: () => disablePush() }));

import { YourData } from "./your-data";

/**
 * Settings → Your data. The export is one tap per format and needs no state;
 * the deletion is the one action in the app with no undo, so what is tested
 * here is the door: nothing reaches `DELETE /api/account` without the typed
 * word, and a failure says nothing was removed.
 */

let assigned: string | null = null;

beforeEach(() => {
  disablePush.mockReset().mockResolvedValue(true);
  assigned = null;
  // jsdom cannot navigate; record where the page would have gone.
  vi.stubGlobal("location", {
    ...window.location,
    set href(value: string) {
      assigned = value;
    },
    get href() {
      return assigned ?? "http://localhost/settings";
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(response: { ok: boolean; status?: number } | Error) {
  const fn = vi.fn().mockImplementation(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, status: response.status ?? 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("YourData export", () => {
  it("offers JSON and CSV as direct downloads of the export route", () => {
    render(<YourData />);
    const json = screen.getByRole("link", { name: /download json/i });
    const csv = screen.getByRole("link", { name: /download csv/i });
    expect(json).toHaveAttribute("href", "/api/account/export?format=json");
    expect(csv).toHaveAttribute("href", "/api/account/export?format=csv");
    expect(json).toHaveAttribute("download");
    expect(csv).toHaveAttribute("download");
  });
});

describe("DeleteAccount confirm", () => {
  it("opens a dialog that says what goes, and cannot delete until the word is typed", async () => {
    const fetch = stubFetch({ ok: true });
    render(<YourData />);
    await userEvent.click(screen.getByRole("button", { name: /delete account/i }));

    const dialog = screen.getByRole("alertdialog", { name: /delete your account/i });
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(dialog).toHaveTextContent(/reports you filed stay with the moderators, without your name/i);
    const confirm = screen.getByRole("button", { name: "Delete my account" });
    expect(confirm).toBeDisabled();

    const input = screen.getByLabelText(/type delete to confirm/i);
    expect(input).toHaveFocus();
    await userEvent.type(input, "delet");
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deletes with the typed word, releases this device first, and leaves the app", async () => {
    const fetch = stubFetch({ ok: true });
    render(<YourData />);
    await userEvent.click(screen.getByRole("button", { name: /delete account/i }));
    // Lower case is fine: the point is intent, not a spelling test.
    await userEvent.type(screen.getByLabelText(/type delete to confirm/i), "delete");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));

    await waitFor(() => expect(assigned).toBe("/"));
    expect(disablePush).toHaveBeenCalledTimes(1);
    expect(disablePush.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]);
    expect(fetch).toHaveBeenCalledWith("/api/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "delete" }),
    });
  });

  it("still deletes when the push release fails", async () => {
    disablePush.mockRejectedValue(new Error("offline"));
    const fetch = stubFetch({ ok: true });
    render(<YourData />);
    await userEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await userEvent.type(screen.getByLabelText(/type delete to confirm/i), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(assigned).toBe("/"));
  });

  it("says nothing was removed when the server refuses, and stays put", async () => {
    stubFetch({ ok: false, status: 500 });
    render(<YourData />);
    await userEvent.click(screen.getByRole("button", { name: /delete account/i }));
    await userEvent.type(screen.getByLabelText(/type delete to confirm/i), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing was removed/i);
    expect(assigned).toBeNull();
    // The dialog is still there and usable for a retry.
    expect(screen.getByRole("button", { name: "Delete my account" })).toBeEnabled();
  });

  it("closes on Cancel and on Escape, clearing what was typed", async () => {
    stubFetch({ ok: true });
    render(<YourData />);
    const trigger = screen.getByRole("button", { name: /delete account/i });
    await userEvent.click(trigger);
    await userEvent.type(screen.getByLabelText(/type delete to confirm/i), "DEL");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(trigger).toHaveFocus();

    await userEvent.click(trigger);
    expect(screen.getByLabelText(/type delete to confirm/i)).toHaveValue("");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
