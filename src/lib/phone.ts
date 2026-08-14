/**
 * Phone normalization + keyed hashing (docs/SOCIAL.md §7.2, D8 as amended).
 *
 * Pure, no DB — src/lib/social.ts is the only caller and owns everything
 * stateful (storage, rate limiting, opt-in checks). The raw number never
 * leaves this module: callers pass it in once, get back a canonical string to
 * hash/display-truncate, and the caller is responsible for never logging or
 * persisting the raw form.
 */
import { createHmac } from "node:crypto";

export class InvalidPhoneError extends Error {
  constructor() {
    super("Invalid phone number");
    this.name = "InvalidPhoneError";
  }
}

const NON_DIGIT_PUNCTUATION = /[\s\-().]/g;

/**
 * Normalize to an E.164-ish canonical form: strip spaces/dashes/parens/dots,
 * turn a leading "00" (international dial-out prefix) into "+", and assume a
 * bare 10-digit number is a US number (documented default — the app launches
 * US-first). The result must be "+" followed by 8–15 digits (E.164's own
 * bound). Throws InvalidPhoneError for anything else — letters, too
 * short/long, or a number that arrives with neither a "+" nor exactly 10
 * digits to default from.
 */
export function normalizePhone(raw: string): string {
  let stripped = raw.trim().replace(NON_DIGIT_PUNCTUATION, "");

  if (stripped.startsWith("00")) {
    stripped = `+${stripped.slice(2)}`;
  }

  if (!stripped.startsWith("+")) {
    if (/^\d{10}$/.test(stripped)) {
      stripped = `+1${stripped}`;
    } else {
      throw new InvalidPhoneError();
    }
  }

  const digits = stripped.slice(1);
  if (!/^\d+$/.test(digits) || digits.length < 8 || digits.length > 15) {
    throw new InvalidPhoneError();
  }
  return `+${digits}`;
}

function phoneKey(): string {
  return process.env.WHAIKEY_PHONE_KEY ?? process.env.BETTER_AUTH_SECRET ?? "dev-phone-key";
}

/**
 * HMAC-SHA256(canonical, key) hex. Keyed (not a bare hash) so a DB leak alone
 * can't be brute-forced over the phone-number space by an attacker who
 * doesn't also have the server secret.
 */
export function hashPhone(canonical: string): string {
  return createHmac("sha256", phoneKey()).update(canonical).digest("hex");
}

/** Last two digits, for the owner to recognize which number they registered — never shown to anyone else. */
export function phoneLast2(canonical: string): string {
  return canonical.slice(-2);
}
