import { NextResponse } from "next/server";

/**
 * Android App Links verification file.
 *
 * Android fetches this at install time and, if the signing fingerprint matches,
 * lets `android:autoVerify="true"` intent filters open https:// links directly in
 * the app (see android/app/src/main/AndroidManifest.xml).
 *
 * The fingerprint is the SHA-256 of the **app signing key**, which under Play App
 * Signing is Google's key, not the upload key — copy it from Play Console →
 * Release → Setup → App signing (docs/APP_STORE_SETUP.md §4.3). Multiple
 * fingerprints can be listed comma-separated so a locally-signed debug build can
 * verify alongside the Play-signed release.
 */
export const dynamic = "force-static";

const PACKAGE_NAME = "com.whaikey.app";

export async function GET() {
  const fingerprints = (process.env.ANDROID_CERT_FINGERPRINTS ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  if (fingerprints.length === 0) {
    // Publishing an empty target list would tell Android verification failed;
    // 404 leaves it unverified instead, and links fall back to the browser.
    return NextResponse.json({ error: "Not configured" }, { status: 404 });
  }

  return NextResponse.json(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: PACKAGE_NAME,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ],
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",
      },
    },
  );
}
