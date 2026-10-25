import { describe, expect, it, vi } from "vitest";
import { identifyLabel, ocrGuess } from "./label-scan";
import type { OcrResult } from "@/lib/native/ocr";

const bottle = (id: string, name = id) => ({
  id,
  name,
  category: "bourbon" as const,
  region: null,
  country: null,
  ageYears: null,
  abv: null,
  msrp: null,
  avgPrice: null,
  distillery: null,
});

const OCR: OcrResult = {
  engine: "vision",
  lines: [
    { text: "LAGAVULIN", height: 0.12 },
    { text: "ISLAY SINGLE MALT", height: 0.03 },
    { text: "16 YEARS", height: 0.06 },
  ],
};

function router(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string | URL | Request) => {
    const handler = routes[String(url)];
    if (!handler) throw new Error(`unexpected ${String(url)}`);
    return handler();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("identifyLabel", () => {
  it("a confident on-device read never calls the AI", async () => {
    const f = router({
      "/api/scan/label-text": () => Response.json({ confident: true, candidates: [bottle("lag16")] }),
    });
    const r = await identifyLabel("data:image/jpeg;base64,QUJD", "image/jpeg", { fetch: f, recognize: async () => OCR });
    expect(r).toMatchObject({ via: "ocr", candidates: [{ id: "lag16" }], guess: "LAGAVULIN 16 YEARS" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a low-confidence read falls back to the AI and keeps its extras", async () => {
    const f = router({
      "/api/scan/label-text": () => Response.json({ confident: false, candidates: [bottle("lag8"), bottle("lag16")] }),
      "/api/scan-label": () =>
        Response.json({ extracted: { brandGuess: "Lagavulin", expressionGuess: "16" }, candidates: [bottle("lag16")] }),
    });
    const r = await identifyLabel("data:image/jpeg;base64,QUJD", "image/jpeg", { fetch: f, recognize: async () => OCR });
    expect(r.via).toBe("ai");
    expect(r.candidates.map((c) => c.id)).toEqual(["lag16", "lag8"]);
    const aiBody = JSON.parse(String((f.mock.calls[1][1] as RequestInit).body));
    expect(aiBody).toEqual({ imageBase64: "QUJD", mediaType: "image/jpeg" });
  });

  it("on the web (no engine) it is the AI-only flow", async () => {
    const f = router({
      "/api/scan-label": () => Response.json({ extracted: { brandGuess: null, expressionGuess: null }, candidates: [] }),
    });
    const r = await identifyLabel("data:image/jpeg;base64,QUJD", "image/jpeg", { fetch: f, recognize: async () => null });
    expect(r).toMatchObject({ via: "ai", candidates: [], guess: null });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("AI unconfigured or over budget still offers the on-device candidates", async () => {
    for (const [status, why] of [
      [503, "unconfigured"],
      [429, "limited"],
    ] as const) {
      const f = router({
        "/api/scan/label-text": () => Response.json({ confident: false, candidates: [bottle("lag16")] }),
        "/api/scan-label": () => new Response("", { status }),
      });
      const r = await identifyLabel("x", "image/jpeg", { fetch: f, recognize: async () => OCR });
      expect(r).toMatchObject({ via: "ocr", aiUnavailable: why, candidates: [{ id: "lag16" }] });
    }
  });

  it("a failing label-text call is not fatal", async () => {
    const f = router({
      "/api/scan/label-text": () => new Response("", { status: 500 }),
      "/api/scan-label": () => Response.json({ extracted: { brandGuess: "X", expressionGuess: null }, candidates: [] }),
    });
    const r = await identifyLabel("x", "image/jpeg", { fetch: f, recognize: async () => OCR });
    expect(r.via).toBe("ai");
  });

  it("throws only when nothing at all could be read", async () => {
    const f = router({ "/api/scan-label": () => new Response("", { status: 500 }) });
    await expect(identifyLabel("x", "image/jpeg", { fetch: f, recognize: async () => null })).rejects.toThrow();
  });
});

describe("ocrGuess", () => {
  it("takes the two largest lines in label order", () => {
    expect(ocrGuess(OCR)).toBe("LAGAVULIN 16 YEARS");
  });
});

describe("identifyLabel when the AI request drops", () => {
  it("returns the OCR candidates instead of failing", async () => {
    const f = router({
      "/api/scan/label-text": () => Response.json({ confident: false, candidates: [bottle("lag16")] }),
      "/api/scan-label": () => {
        throw new TypeError("fetch failed");
      },
    });
    const r = await identifyLabel("data:image/jpeg;base64,QUJD", "image/jpeg", { fetch: f, recognize: async () => OCR });
    expect(r).toMatchObject({ via: "ocr", aiUnavailable: null });
    expect(r.candidates.map((c) => c.id)).toEqual(["lag16"]);
  });
});

describe("identifyLabel OCR fallback header", () => {
  it("tells the AI endpoint how many OCR candidates it holds once the free pass was deferred", async () => {
    const f = router({
      "/api/scan/label-text": () => Response.json({ confident: false, candidates: [bottle("a"), bottle("b")] }),
      "/api/scan-label": () => Response.json({ error: "AI features are not configured" }, { status: 503 }),
    });
    await identifyLabel("data:image/jpeg;base64,QUJD", "image/jpeg", { fetch: f, recognize: async () => OCR });
    const aiCall = f.mock.calls.find(([url]) => String(url) === "/api/scan-label");
    expect((aiCall?.[1] as RequestInit).headers).toMatchObject({ "x-whaikey-ocr-fallback": "2" });
  });
});
