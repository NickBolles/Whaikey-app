// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { social, searchParams, startNativeSignIn } = vi.hoisted(() => ({
  social: vi.fn(),
  searchParams: { value: new URLSearchParams() },
  startNativeSignIn: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({ signIn: { social } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => searchParams.value }));
// On the web this reports "unavailable" and the page falls through to the normal
// in-page flow; the native branch is covered in src/lib/native/auth.test.ts.
vi.mock("@/lib/native/auth", () => ({ startNativeSignIn }));

import SignInPage from "./page";

afterEach(cleanup);
beforeEach(() => {
  social.mockReset();
  searchParams.value = new URLSearchParams();
  startNativeSignIn.mockResolvedValue({ status: "unavailable" });
});

describe("SignInPage", () => {
  it("shows a connecting state and disables both buttons while the OAuth call is in flight", async () => {
    let resolve!: (v: unknown) => void;
    social.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<SignInPage />);

    await userEvent.click(screen.getByRole("button", { name: /Continue with Google/i }));

    expect(screen.getByRole("button", { name: /Connecting…/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue with Apple/i })).toBeDisabled();
    // Resolve the pending promise so it doesn't leak into the next test.
    resolve(undefined);
  });

  it("surfaces the auth service's error message and re-enables the buttons", async () => {
    social.mockResolvedValue({ error: { message: "Provider misconfigured" } });
    render(<SignInPage />);

    await userEvent.click(screen.getByRole("button", { name: /Continue with Apple/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Provider misconfigured"),
    );
    // After a failure both buttons are interactive again (pending cleared).
    expect(screen.getByRole("button", { name: /Continue with Google/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Continue with Apple/i })).toBeEnabled();
  });

  it("does not fire a second OAuth call while one is already pending", async () => {
    let resolve!: (v: unknown) => void;
    social.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<SignInPage />);

    const google = screen.getByRole("button", { name: /Continue with Google/i });
    await userEvent.click(google);
    // Button is disabled, but guard against programmatic double-submits too.
    await userEvent.click(google);

    expect(social).toHaveBeenCalledTimes(1);
    resolve(undefined);
  });

  it("surfaces an error handed back by the native sign-in redirect", async () => {
    // A cancelled native sign-in returns through whaikey:// and lands here as a
    // query parameter, not as a rejected promise.
    searchParams.value = new URLSearchParams("error=Sign-in was cancelled.");
    render(<SignInPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in was cancelled.");
  });

  it("clears the redirect error once the user tries again", async () => {
    searchParams.value = new URLSearchParams("error=Sign-in was cancelled.");
    let resolve!: (v: unknown) => void;
    social.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<SignInPage />);

    await userEvent.click(screen.getByRole("button", { name: /Continue with Google/i }));

    // The stale message stays in the URL, so it has to be suppressed explicitly
    // rather than left to fall out of the query string.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    resolve(undefined);
  });

  it("hands off to the system browser on a device instead of signing in inline", async () => {
    startNativeSignIn.mockResolvedValue({ status: "started" });
    render(<SignInPage />);

    await userEvent.click(screen.getByRole("button", { name: /Continue with Google/i }));

    // Google rejects OAuth from an embedded WebView, so the in-page flow must
    // not run at all once the native handoff has taken over.
    expect(startNativeSignIn).toHaveBeenCalledWith("google", undefined);
    expect(social).not.toHaveBeenCalled();
  });
});

describe("return path (?next=)", () => {
  it("passes a same-origin next path through as the OAuth callbackURL", async () => {
    social.mockResolvedValue(undefined);
    searchParams.value = new URLSearchParams("next=%2Fadd%2Fsasha");
    render(<SignInPage />);
    await userEvent.click(screen.getByRole("button", { name: /Continue with Google/i }));
    await waitFor(() =>
      expect(social).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: "/add/sasha" })),
    );
  });

  it("falls back to '/' for absolute or protocol-relative next values (no open redirect)", async () => {
    for (const evil of ["https://evil.example/x", "//evil.example/x"]) {
      social.mockReset();
      social.mockResolvedValue(undefined);
      searchParams.value = new URLSearchParams([["next", evil]]);
      const { unmount } = render(<SignInPage />);
      await userEvent.click(screen.getByRole("button", { name: /Continue with Google/i }));
      await waitFor(() =>
        expect(social).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: "/" })),
      );
      unmount();
    }
  });
});
