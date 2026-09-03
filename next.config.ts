import type { NextConfig } from "next";

/**
 * Content Security Policy (review SEC-H3).
 *
 * Sized to what the app actually loads, which is very little from anywhere
 * else: fonts are self-hosted through `next/font/local`, barcode scanning is
 * the browser's own `BarcodeDetector`, there are no workers, no blob URLs, and
 * no cross-origin client fetches. The two loose directives are load-bearing:
 *
 * - `img-src … https:` because bottle art is source-owned media on whatever
 *   host the catalog pipeline found it on (PLAN.md §4.6), and `data:` because
 *   the QR card and the label capture both render canvas output.
 * - `'unsafe-inline'` on script and style because Next inlines its hydration
 *   bootstrap and Tailwind emits inline style attributes. Tightening `script`
 *   to a nonce means threading one through the root layout on every render;
 *   that is the follow-up, and the reason this ships report-only first.
 *
 * `'unsafe-eval'` is development-only. React's dev build uses `eval` to
 * reconstruct callstacks across environments; the production build never does,
 * and giving the deployed app the directive to keep `pnpm dev` quiet would
 * hand back most of what the policy is for.
 *
 * `frame-ancestors 'none'` is the point of the exercise: /sharing carries
 * "Make everything private" and link revocation, and a framed clickjack of
 * those is a real, boring attack.
 */
const isDev = process.env.NODE_ENV !== "production";

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "media-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "report-uri /api/csp-report",
].join("; ");

/**
 * A CSP that breaks a page is worse than the one it replaced, so it goes out
 * observing before it goes out enforcing: violations are reported and nothing
 * is blocked until `WHAIKEY_CSP_ENFORCE` is set. The e2e suite runs with it
 * enforced, which is what makes report-only more than a shrug — every
 * directive here is one the app has been driven through. The exception is
 * `script-src`, which e2e can only exercise against the dev build; that is the
 * directive the production reports are actually for.
 */
const cspHeaderName =
  process.env.WHAIKEY_CSP_ENFORCE === "true"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

const securityHeaders = [
  { key: cspHeaderName, value: CSP },
  // Two years, preloadable. The app is https-only in production; a downgrade
  // is a session cookie in the clear.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // /s/<code> share links are bearer credentials. Without this the code rides
  // the Referer of every outbound link and third-party image on the page.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Belt and braces with frame-ancestors, for anything that predates CSP.
  { key: "X-Frame-Options", value: "DENY" },
  // Camera stays: /scan is a first-party camera surface on the web too.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  // Keep the dev-tools badge out of visual regression screenshots.
  devIndicators: false,
  // Keep the DB drivers external (loaded via native require, not bundled):
  // postgres-js is server-only, and PGlite's WASM payload (local dev / tests)
  // must never enter the serverless bundle.
  serverExternalPackages: ["postgres", "@electric-sql/pglite"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
