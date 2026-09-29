import { describe, expect, it } from "vitest";
import { isValidUpc, normalizeUpc } from "./upc";

// The GTIN helpers every scan path funnels through (review REL-8.4: until now
// covered only indirectly by the scan route tests). Known-good codes are the
// published GS1 / Wikipedia examples, not values computed by the code under
// test.

describe("normalizeUpc", () => {
  it("keeps the four GTIN lengths as digits", () => {
    expect(normalizeUpc("73513537")).toBe("73513537"); // EAN-8
    expect(normalizeUpc("036000291452")).toBe("036000291452"); // UPC-A
    expect(normalizeUpc("4006381333931")).toBe("4006381333931"); // EAN-13
    expect(normalizeUpc("10012345678902")).toBe("10012345678902"); // GTIN-14
  });

  it("collapses GTIN-13/14 zero-padding to the 12-digit UPC-A, so one bottle has one key", () => {
    expect(normalizeUpc("0036000291452")).toBe("036000291452");
    expect(normalizeUpc("00036000291452")).toBe("036000291452");
    expect(normalizeUpc("0080244002145")).toBe(normalizeUpc("080244002145"));
  });

  it("never strips a UPC-A's own leading zero", () => {
    expect(normalizeUpc("036000291452")).toBe("036000291452");
  });

  it("strips spaces, dashes and other scanner/typing noise", () => {
    expect(normalizeUpc(" 0 36000-29145 2 ")).toBe("036000291452");
    expect(normalizeUpc("UPC: 036000291452\n")).toBe("036000291452");
  });

  it("rejects lengths no GTIN has, and inputs with no digits", () => {
    for (const raw of ["", "abc", "1234567", "123456789", "1234567890", "12345678901", "123456789012345"]) {
      expect(normalizeUpc(raw)).toBeNull();
    }
  });
});

describe("isValidUpc", () => {
  it("accepts published valid codes at every length", () => {
    for (const code of ["73513537", "036000291452", "4006381333931", "10012345678902"]) {
      expect(isValidUpc(code)).toBe(true);
    }
  });

  it("rejects every wrong check digit", () => {
    const body = "03600029145";
    const valid = Number("036000291452".slice(-1));
    for (let d = 0; d <= 9; d++) {
      expect(isValidUpc(`${body}${d}`)).toBe(d === valid);
    }
  });

  it("catches a single-digit typo and an adjacent transposition", () => {
    expect(isValidUpc("036000291462")).toBe(false); // one digit off
    expect(isValidUpc("036000921452")).toBe(false); // "29" → "92"
  });

  it("expects normalized input: rejects non-digits and non-GTIN lengths", () => {
    expect(isValidUpc("0360-0029-1452")).toBe(false);
    expect(isValidUpc(" 036000291452")).toBe(false);
    expect(isValidUpc("")).toBe(false);
    expect(isValidUpc("1234567")).toBe(false);
  });

  it("agrees with normalizeUpc on padded input", () => {
    const n = normalizeUpc("0036000291452");
    expect(n && isValidUpc(n)).toBe(true);
  });
});
