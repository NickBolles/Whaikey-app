/**
 * Server-side "now". The visual suite pins the browser clock
 * (page.clock.setFixedTime), but server components render with the real
 * clock — so anything month- or date-shaped computed on the server would
 * drift out from under the committed baselines. WHAIKEY_FAKE_NOW (set only
 * by playwright.config.ts, to the same instant the browser is pinned to)
 * closes that gap; dev and production never set it.
 */
export function appNow(): Date {
  const fake = process.env.WHAIKEY_FAKE_NOW;
  if (fake) {
    const parsed = new Date(fake);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}
