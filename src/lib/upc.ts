/**
 * Pure GTIN (UPC/EAN) helpers, safe to import from client components — no DB
 * or server dependencies. Server-side resolution lives in src/lib/scan.ts.
 */

/**
 * Normalize a scanned/typed barcode to canonical GTIN digits: strips
 * non-digits, then removes GTIN-13/14 zero-padding down to 12-digit UPC-A so
 * "0080244002145" and "080244002145" resolve identically. Returns null when
 * the result isn't a plausible GTIN length (8, 12, 13, or 14 digits).
 */
export function normalizeUpc(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  while (digits.length > 12 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  return digits;
}

/** GS1 mod-10 check digit over the body (all but the last digit) of a GTIN. */
function gtinCheckDigit(body: string): number {
  let sum = 0;
  const ds = body.split("").reverse();
  for (let i = 0; i < ds.length; i++) {
    sum += Number(ds[i]) * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** True when `upc` is a normalized GTIN with a valid check digit. */
export function isValidUpc(upc: string): boolean {
  if (!/^\d+$/.test(upc) || ![8, 12, 13, 14].includes(upc.length)) return false;
  return gtinCheckDigit(upc.slice(0, -1)) === Number(upc.slice(-1));
}
