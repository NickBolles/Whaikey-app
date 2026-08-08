// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { share } from "./share";

const REQUEST = {
  title: "Ardbeg 10",
  text: "Rated 4.5 — smoke, brine, lemon peel.",
  url: "https://app.whaikey.com/bottles/ardbeg-10",
};

afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

function stub(key: "share" | "clipboard", value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true });
}

describe("share", () => {
  it("uses the Web Share API when the browser has one", async () => {
    const webShare = vi.fn(async () => {});
    stub("share", webShare);

    await expect(share(REQUEST)).resolves.toBe("shared");
    expect(webShare).toHaveBeenCalledWith({
      title: REQUEST.title,
      text: REQUEST.text,
      url: REQUEST.url,
    });
  });

  it("falls back to the clipboard when sharing is unavailable", async () => {
    const writeText = vi.fn(async () => {});
    stub("clipboard", { writeText });

    await expect(share(REQUEST)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(`${REQUEST.text}\n${REQUEST.url}`);
  });

  it("falls back to the clipboard when the user cancels the share sheet", async () => {
    stub("share", vi.fn(async () => Promise.reject(new Error("AbortError"))));
    const writeText = vi.fn(async () => {});
    stub("clipboard", { writeText });

    await expect(share(REQUEST)).resolves.toBe("copied");
  });

  it("reports unavailable rather than throwing when nothing can handle it", async () => {
    // The caller uses this to decide whether to show a confirmation toast.
    await expect(share(REQUEST)).resolves.toBe("unavailable");
  });

  it("reports unavailable when there is no text or url to copy", async () => {
    await expect(share({ title: "Whaikey" })).resolves.toBe("unavailable");
  });
});
