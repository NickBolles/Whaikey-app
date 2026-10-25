// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DRAFT_TTL_MS, clearDraft, hasDraftContent, loadDraft, saveDraft, type DraftContent } from "./pour-draft";

const empty: DraftContent = {
  bottle: null,
  rating: null,
  servingStyle: null,
  amountMl: 45,
  freeform: "",
  nose: "",
  palate: "",
  finish: "",
  flavorTags: {},
  companions: "",
};

afterEach(() => window.localStorage.clear());

describe("pour draft (STORYBOARD Q2)", () => {
  it("an untouched sheet is not a draft", () => {
    expect(hasDraftContent(empty)).toBe(false);
    saveDraft("u1", empty);
    expect(window.localStorage.length).toBe(0);
  });

  it("round-trips per account and expires after 24 h", () => {
    const now = 1_000_000;
    saveDraft("u1", { ...empty, nose: "smoke" }, now);
    expect(loadDraft("u2", now)).toBeNull();
    expect(loadDraft("u1", now + 1000)?.nose).toBe("smoke");
    expect(loadDraft("u1", now + DRAFT_TTL_MS + 1)).toBeNull();
    // The expired draft is cleaned up, not left behind.
    expect(window.localStorage.length).toBe(0);
  });

  it("clearDraft forgets it", () => {
    saveDraft("u1", { ...empty, rating: 4 });
    clearDraft("u1");
    expect(loadDraft("u1")).toBeNull();
  });

  it("survives junk in storage", () => {
    window.localStorage.setItem("whaikey:pour-draft:v1:u1", "{not json");
    expect(loadDraft("u1")).toBeNull();
  });
});
