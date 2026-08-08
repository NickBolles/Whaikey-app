// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const router = { back: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { NativeShell } from "@/components/native-shell";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "Capacitor");
  document.documentElement.classList.remove("native-app");
  vi.clearAllMocks();
});

describe("NativeShell", () => {
  it("renders nothing", () => {
    const { container } = render(<NativeShell />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays entirely inert on the web", () => {
    // The web app must not pay for the native shell — no marker class, no
    // navigation, no plugin work.
    render(<NativeShell />);
    expect(document.documentElement).not.toHaveClass("native-app");
    expect(router.back).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("marks the document as native so CSS can target the shell", () => {
    Object.defineProperty(window, "Capacitor", {
      value: { getPlatform: () => "ios", isNativePlatform: () => true },
      configurable: true,
      writable: true,
    });

    const { unmount } = render(<NativeShell />);
    expect(document.documentElement).toHaveClass("native-app");

    unmount();
    expect(document.documentElement).not.toHaveClass("native-app");
  });
});
