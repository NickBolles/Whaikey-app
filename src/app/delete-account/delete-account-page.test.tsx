// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockSessionModule, setSessionUser } from "@/test/helpers";

vi.mock("@/lib/session", async () => mockSessionModule());

import DeleteAccountPage from "./page";
import { DELETION_REQUEST_TAG } from "./deletion-request-form";

/**
 * `/delete-account` (Google Play's web deletion requirement): it has to work
 * signed out, name the app and developer, explain the in-app path, and reuse
 * the real deletion for a signed-in visitor rather than describe it.
 */
afterEach(() => {
  cleanup();
  setSessionUser(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/delete-account", () => {
  it("signed out: explains the in-app path, offers sign-in and a request form", async () => {
    render(await DeleteAccountPage());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/Delete your Caskfolk account/);
    expect(document.body.textContent).toMatch(/Settings/);
    expect(document.body.textContent).toMatch(/published by the Caskfolk developer/);
    const signIn = screen.getByRole("link", { name: "Sign in to delete" });
    expect(signIn.getAttribute("href")).toBe("/sign-in?next=%2Fdelete-account");
    expect(screen.getByRole("button", { name: "Request deletion" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete account/ })).toBeNull();
    expect(screen.getByRole("link", { name: "privacy policy" }).getAttribute("href")).toBe(
      "/privacy#getting-it-out",
    );
  });

  it("names the legal entity once the owner has supplied it", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY", "Example Spirits LLC");
    render(await DeleteAccountPage());
    expect(document.body.textContent).toMatch(/published by Example Spirits LLC/);
  });

  it("signed in: shows the same delete button as Settings, not the request form", async () => {
    setSessionUser({ id: "u1", name: "Ada", email: "ada@example.com" });
    render(await DeleteAccountPage());
    expect(screen.getByRole("button", { name: /Delete account/ })).toBeTruthy();
    expect(document.body.textContent).toMatch(/ada@example.com/);
    expect(screen.queryByRole("button", { name: "Request deletion" })).toBeNull();
  });

  it("files a signed-out request into the support queue, tagged, with the address to confirm", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(await DeleteAccountPage());
    fireEvent.change(screen.getByLabelText("Account email"), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Request deletion" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/ada@example.com/));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/feedback");
    const body = JSON.parse(String(init.body));
    expect(body.platform).toBe(DELETION_REQUEST_TAG);
    expect(body.contact).toBe("ada@example.com");
    expect(body.body).toMatch(/deletion request/i);
  });

  it("refuses to send without a plausible email", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(await DeleteAccountPage());
    fireEvent.click(screen.getByRole("button", { name: "Request deletion" }));
    expect(screen.getByRole("alert").textContent).toMatch(/email/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
