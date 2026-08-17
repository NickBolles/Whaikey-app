import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidPhoneError, hashPhone, normalizePhone, phoneLast2 } from "@/lib/phone";

describe("normalizePhone", () => {
  it("strips spaces, dashes, parens, and dots", () => {
    expect(normalizePhone("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizePhone("+1.415.555.0123")).toBe("+14155550123");
    expect(normalizePhone("+1-415-555-0123")).toBe("+14155550123");
  });

  it("turns a 00 international prefix into +", () => {
    expect(normalizePhone("0044 7911 123456")).toBe("+447911123456");
    expect(normalizePhone("00 33 6 12 34 56 78")).toBe("+33612345678");
  });

  it("assumes +1 for a bare 10-digit number (documented US default)", () => {
    expect(normalizePhone("4155550123")).toBe("+14155550123");
    expect(normalizePhone("415-555-0123")).toBe("+14155550123");
  });

  it("is idempotent-ish across equivalent inputs", () => {
    expect(normalizePhone("4155550123")).toBe(normalizePhone("+1 415 555 0123"));
  });

  it("rejects too short and too long numbers", () => {
    expect(() => normalizePhone("+1234")).toThrow(InvalidPhoneError); // 4 digits, under the 8-digit floor
    expect(() => normalizePhone("+1234567")).toThrow(InvalidPhoneError); // 7 digits, still under the floor
    expect(() => normalizePhone("+1234567890123456")).toThrow(InvalidPhoneError); // 16 digits, over the 15 ceiling
  });

  it("rejects letters and other non-digit content", () => {
    expect(() => normalizePhone("+1-CALL-NOW1")).toThrow(InvalidPhoneError);
    expect(() => normalizePhone("not a phone number")).toThrow(InvalidPhoneError);
  });

  it("rejects a number with no + and not exactly 10 digits (no default to fall back to)", () => {
    expect(() => normalizePhone("155501234567")).toThrow(InvalidPhoneError);
    expect(() => normalizePhone("12345")).toThrow(InvalidPhoneError);
  });

  it("rejects empty input", () => {
    expect(() => normalizePhone("")).toThrow(InvalidPhoneError);
    expect(() => normalizePhone("   ")).toThrow(InvalidPhoneError);
  });

  it("accepts the boundary lengths (8 and 15 digits)", () => {
    expect(normalizePhone("+12345678")).toBe("+12345678");
    expect(normalizePhone("+123456789012345")).toBe("+123456789012345");
  });
});

describe("hashPhone", () => {
  const ORIGINAL_PHONE_KEY = process.env.WHAIKEY_PHONE_KEY;
  const ORIGINAL_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

  afterEach(() => {
    if (ORIGINAL_PHONE_KEY === undefined) delete process.env.WHAIKEY_PHONE_KEY;
    else process.env.WHAIKEY_PHONE_KEY = ORIGINAL_PHONE_KEY;
    if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = ORIGINAL_AUTH_SECRET;
  });

  beforeEach(() => {
    delete process.env.WHAIKEY_PHONE_KEY;
    delete process.env.BETTER_AUTH_SECRET;
  });

  it("is deterministic for the same canonical number and key", () => {
    const a = hashPhone("+14155550123");
    const b = hashPhone("+14155550123");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // hex sha256
  });

  it("differs for different numbers under the same key", () => {
    expect(hashPhone("+14155550123")).not.toBe(hashPhone("+14155550124"));
  });

  it("falls back through WHAIKEY_PHONE_KEY -> BETTER_AUTH_SECRET -> dev default, in that order", () => {
    const devDefault = hashPhone("+14155550123");

    process.env.BETTER_AUTH_SECRET = "auth-secret";
    const withAuthSecret = hashPhone("+14155550123");
    expect(withAuthSecret).not.toBe(devDefault);

    process.env.WHAIKEY_PHONE_KEY = "phone-specific-key";
    const withPhoneKey = hashPhone("+14155550123");
    expect(withPhoneKey).not.toBe(withAuthSecret);
    expect(withPhoneKey).not.toBe(devDefault);

    // WHAIKEY_PHONE_KEY wins over BETTER_AUTH_SECRET when both are set.
    process.env.WHAIKEY_PHONE_KEY = "phone-specific-key";
    process.env.BETTER_AUTH_SECRET = "a-different-auth-secret";
    expect(hashPhone("+14155550123")).toBe(withPhoneKey);
  });

  it("is sensitive to the key: different key, different hash for the same number", () => {
    process.env.WHAIKEY_PHONE_KEY = "key-one";
    const withKeyOne = hashPhone("+14155550123");
    process.env.WHAIKEY_PHONE_KEY = "key-two";
    const withKeyTwo = hashPhone("+14155550123");
    expect(withKeyOne).not.toBe(withKeyTwo);
  });
});

describe("phoneLast2", () => {
  it("returns the last two digits of the canonical number", () => {
    expect(phoneLast2("+14155550123")).toBe("23");
    expect(phoneLast2(normalizePhone("4155550199"))).toBe("99");
  });
});
