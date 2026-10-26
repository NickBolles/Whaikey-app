/**
 * The app's user-facing brand, in one place.
 *
 * Owner decision 2026-10-26: the app is called Caskfolk "for now". Everything a
 * person reads — page titles, headers, share text, notifications, policy pages,
 * the PWA manifest — comes from here, so another rename is a one-file change
 * plus the native display names (capacitor.config.ts, Info.plist, strings.xml)
 * and the raster art in native/assets/.
 *
 * Deliberately NOT derived from this (pending the final name decision, because
 * they are permanent or need a purchase): the bundle id `com.whaikey.app`, the
 * Capacitor appId, the `whaikey://` scheme, the Vercel project and domain, DB
 * names, `WHAIKEY_*` env vars, cookie/storage keys and other internal ids.
 */
export const BRAND_NAME = "Caskfolk";

/** Lower-case slug for user-visible file names (exports, share images). */
export const BRAND_SLUG = "caskfolk";

export const BRAND_TAGLINE = "Pull up a chair.";

/** Ground colour of the dark theme: status bar, PWA theme, native splash. */
export const BRAND_BACKGROUND = "#0d1410";
