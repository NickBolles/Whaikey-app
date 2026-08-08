// Shared resolution of the native shell's server URL (docs/NATIVE_APP.md §2.2).
// The WebView loads this origin; `native/shell` only ships as the offline fallback.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shellDir = path.join(repoRoot, "native", "shell");

/** The origin baked into the build, or "" when this checkout has none configured. */
export function serverUrl() {
  return (process.env.CAP_SERVER_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
}

/**
 * Problems that should stop a release build. Returns human-readable strings;
 * an empty array means the native config is releasable.
 */
export function configProblems({ requireServer = true } = {}) {
  const problems = [];
  const url = serverUrl();

  if (!url) {
    if (requireServer) {
      problems.push(
        "No server URL: set CAP_SERVER_URL (or NEXT_PUBLIC_APP_URL) to the deployed app origin.",
      );
    }
  } else {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      problems.push(`Server URL is not a valid URL: ${url}`);
    }
    if (parsed && parsed.protocol !== "https:") {
      // Cleartext is blocked by default on Android API 28+, and a non-secure
      // origin loses getUserMedia — which is the whole scan flow.
      problems.push(`Server URL must be https (got ${parsed.protocol.replace(":", "")}): ${url}`);
    }
  }

  try {
    readFileSync(path.join(shellDir, "index.html"), "utf8");
  } catch {
    problems.push("native/shell/index.html is missing — the offline fallback would not ship.");
  }

  return problems;
}
