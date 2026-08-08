// Rasterizes the brand SVGs in native/assets/ and fans them out into every icon
// and splash size the two platforms want, plus the PWA icons the web app serves.
//
//   pnpm native:assets
//
// Playwright is already the repo's rendering tool (visual regression), so it is
// also the rasterizer here — no extra image dependency, and the output is
// deterministic for a given Chromium build.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { repoRoot } from "./native-config.mjs";

const assetsDir = path.join(repoRoot, "native", "assets");
const publicIcons = path.join(repoRoot, "public", "icons");

/** Icons must be fully opaque — Apple rejects an alpha channel in the 1024px icon. */
const RENDERS = [
  { svg: "icon.svg", out: path.join(assetsDir, "icon.png"), size: 1024 },
  { svg: "splash.svg", out: path.join(assetsDir, "splash.png"), size: 2732 },
  { svg: "icon.svg", out: path.join(publicIcons, "icon-192.png"), size: 192 },
  { svg: "icon.svg", out: path.join(publicIcons, "icon-512.png"), size: 512 },
  { svg: "icon.svg", out: path.join(publicIcons, "apple-touch-icon.png"), size: 180 },
];

mkdirSync(publicIcons, { recursive: true });

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  for (const { svg, out, size } of RENDERS) {
    const source = readFileSync(path.join(assetsDir, svg), "utf8");
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0;background:#14100b}` +
        `svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
    );
    await page.screenshot({ path: out, omitBackground: false });
    await page.close();
    console.log(`• ${path.relative(repoRoot, out)} (${size}×${size})`);
  }
} finally {
  await browser.close();
}

// @capacitor/assets expands icon.png / splash.png into the per-density sets the
// native projects reference. It needs those projects to exist first.
const hasPlatform =
  existsSync(path.join(repoRoot, "ios")) || existsSync(path.join(repoRoot, "android"));
if (!hasPlatform) {
  console.log("✓ Source PNGs rendered. Add a native platform, then re-run to fan them out.");
  process.exit(0);
}

execFileSync(
  "pnpm",
  ["exec", "capacitor-assets", "generate", "--assetPath", path.relative(repoRoot, assetsDir)],
  { cwd: repoRoot, stdio: "inherit" },
);
console.log("✓ Native icon and splash sets generated.");
