// Validates the native shell configuration without needing Xcode, an Android
// SDK, or a network. Safe to run in CI on every push.
//
//   pnpm native:check              # config sanity; missing server URL is a warning
//   pnpm native:check --release    # missing server URL is a failure
import { configProblems, serverUrl } from "./native-config.mjs";

const release = process.argv.includes("--release");
const problems = configProblems({ requireServer: release });

if (problems.length > 0) {
  console.error("✗ Native config is not ready:");
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

const url = serverUrl();
if (url) {
  console.log(`✓ Native config OK — the app will load ${url}`);
} else {
  console.log("✓ Native config OK (no server URL set — builds will boot to the offline shell).");
  console.log("  Set CAP_SERVER_URL before building for a device or store.");
}
