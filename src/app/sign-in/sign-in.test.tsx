// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { social } = vi.hoisted(() => ({ social: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ signIn: { social } }));

import SignInPage from "./page";

afterEach(cleanup);
beforeEach(() => social.mockReset());

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
});
