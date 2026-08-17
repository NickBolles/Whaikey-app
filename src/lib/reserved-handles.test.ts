import { describe, expect, it } from "vitest";
import { RESERVED_HANDLES } from "@/lib/reserved-handles";

describe("reserved handles", () => {
  it("reserves obvious app terms", () => {
    for (const term of ["admin", "whaikey", "support", "api", "sharing", "friends", "bar", "chat"]) {
      expect(RESERVED_HANDLES.has(term)).toBe(true);
    }
  });

  it("reserves major distillery/brand names", () => {
    for (const brand of ["macallan", "lagavulin", "jackdaniels", "glenfiddich", "hibiki", "bulleit"]) {
      expect(RESERVED_HANDLES.has(brand)).toBe(true);
    }
  });

  it("does not reserve an ordinary handle", () => {
    expect(RESERVED_HANDLES.has("dram_wanderer_42")).toBe(false);
  });

  it("stores every entry already lowercase with no separators", () => {
    for (const entry of RESERVED_HANDLES) {
      expect(entry).toBe(entry.toLowerCase());
      expect(entry).not.toMatch(/[\s-]/);
    }
  });
});
