// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64Payload, isOcrAvailable, normalizeOcrResponse, recognizeLabelText } from "./ocr";

const recognizeText = vi.fn();
vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({ recognizeText }),
}));

function fakeNative(platform: "ios" | "android", available = true) {
  Object.defineProperty(window, "Capacitor", {
    value: {
      getPlatform: () => platform,
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => available && name === "WhaikeyOcr",
    },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "Capacitor");
  recognizeText.mockReset();
  vi.restoreAllMocks();
});

describe("availability", () => {
  it("is unavailable on the web, so the caller uses the AI read", async () => {
    expect(isOcrAvailable()).toBe(false);
    await expect(recognizeLabelText("abc")).resolves.toBeNull();
    expect(recognizeText).not.toHaveBeenCalled();
  });

  it("is unavailable in a shell built before the plugin existed", async () => {
    fakeNative("ios", false);
    expect(isOcrAvailable()).toBe(false);
    await expect(recognizeLabelText("abc")).resolves.toBeNull();
  });
});

describe("recognizeLabelText", () => {
  it("sends bare base64 and returns tidied lines", async () => {
    fakeNative("ios");
    recognizeText.mockResolvedValue({
      engine: "vision",
      lines: [
        { text: "  LAGAVULIN ", height: 0.12, confidence: 0.98 },
        { text: "", height: 0.01 },
        { text: "16 YEARS", height: 2, confidence: -1 },
      ],
    });
    const r = await recognizeLabelText("data:image/jpeg;base64,QUJD");
    expect(recognizeText).toHaveBeenCalledWith({ imageBase64: "QUJD" });
    expect(r).toEqual({
      engine: "vision",
      lines: [
        { text: "LAGAVULIN", height: 0.12, confidence: 0.98 },
        { text: "16 YEARS", height: 1, confidence: 0 },
      ],
    });
  });

  it("never throws when the native read fails", async () => {
    fakeNative("android");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    recognizeText.mockRejectedValue(new Error("model not downloaded"));
    await expect(recognizeLabelText("QUJD")).resolves.toBeNull();
  });

  it("treats an empty read as no read", async () => {
    fakeNative("android");
    recognizeText.mockResolvedValue({ lines: [] });
    await expect(recognizeLabelText("QUJD")).resolves.toBeNull();
  });
});

describe("normalizeOcrResponse", () => {
  it("rejects malformed shapes and fills the engine from the platform", () => {
    expect(normalizeOcrResponse(null, "vision")).toBeNull();
    expect(normalizeOcrResponse({ lines: "nope" as never }, "vision")).toBeNull();
    expect(normalizeOcrResponse({ lines: [{ text: 5 }] }, "vision")).toBeNull();
    expect(normalizeOcrResponse({ lines: [{ text: "x" }] }, "mlkit")?.engine).toBe("mlkit");
  });

  it("caps line count and length to the route's limits", () => {
    const r = normalizeOcrResponse({ lines: Array.from({ length: 250 }, () => ({ text: "a".repeat(400) })) }, "vision");
    expect(r?.lines).toHaveLength(200);
    expect(r?.lines[0].text).toHaveLength(300);
  });

  it("base64Payload strips data URL prefixes only", () => {
    expect(base64Payload("data:image/png;base64,AAA")).toBe("AAA");
    expect(base64Payload("AAA")).toBe("AAA");
  });
});
