// Renders the brand SVGs in native/assets/ into every icon and splash raster the
// two platforms need, plus the PWA icons the web app serves.
//
//   pnpm native:assets
//
// Playwright is already this repo's renderer (visual regression), so it is the
// rasterizer here too: no extra image dependency, and deterministic output for a
// given Chromium build. `@capacitor/assets` would do the same job but drags in a
// prebuilt `sharp` binary that does not load on every platform we run on.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { repoRoot } from "./native-config.mjs";

const assets = path.join(repoRoot, "native", "assets");
const ios = path.join(repoRoot, "ios", "App", "App", "Assets.xcassets");
const androidRes = path.join(repoRoot, "android", "app", "src", "main", "res");
const publicIcons = path.join(repoRoot, "public", "icons");

/** App background — every opaque raster is flattened onto this. */
const BACKGROUND = "#14100b";

/** Android density buckets: [dir suffix, launcher px, adaptive foreground px]. */
const DENSITIES = [
  ["mdpi", 48, 108],
  ["hdpi", 72, 162],
  ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324],
  ["xxxhdpi", 192, 432],
];

/** Android splash rasters, matching the dirs Capacitor scaffolds. */
const SPLASHES = [
  ["drawable", 480, 320],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
];

const renders = [];

/**
 * @param {string} svg    source file in native/assets
 * @param {string} out    absolute destination path
 * @param {number} width
 * @param {number} height
 * @param {boolean} transparent  keep the alpha channel (adaptive foregrounds only)
 */
function render(svg, out, width, height, transparent = false) {
  renders.push({ svg, out, width, height, transparent });
}

// --- iOS ---------------------------------------------------------------------
// Modern asset catalogs take a single 1024px icon; Xcode derives the rest.
render("icon.svg", path.join(ios, "AppIcon.appiconset", "AppIcon-512@2x.png"), 1024, 1024);
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
  render("splash.svg", path.join(ios, "Splash.imageset", name), 2732, 2732);
}

// --- Android -----------------------------------------------------------------
for (const [density, launcher, foreground] of DENSITIES) {
  const dir = path.join(androidRes, `mipmap-${density}`);
  render("icon.svg", path.join(dir, "ic_launcher.png"), launcher, launcher);
  render("icon.svg", path.join(dir, "ic_launcher_round.png"), launcher, launcher);
  // Adaptive foreground stays transparent: the launcher composites it over
  // @color/ic_launcher_background and applies its own mask.
  render("icon-foreground.svg", path.join(dir, "ic_launcher_foreground.png"), foreground, foreground, true);
}
for (const [dir, width, height] of SPLASHES) {
  render("splash.svg", path.join(androidRes, dir, "splash.png"), width, height);
}

// --- Web ---------------------------------------------------------------------
render("icon.svg", path.join(publicIcons, "icon-192.png"), 192, 192);
render("icon.svg", path.join(publicIcons, "icon-512.png"), 512, 512);
render("icon.svg", path.join(publicIcons, "apple-touch-icon.png"), 180, 180);

mkdirSync(publicIcons, { recursive: true });

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const sources = new Map();

try {
  for (const { svg, out, width, height, transparent } of renders) {
    if (!existsSync(path.dirname(out))) {
      // A platform that hasn't been added yet — skip rather than fail the run.
      continue;
    }
    if (!sources.has(svg)) sources.set(svg, readFileSync(path.join(assets, svg), "utf8"));

    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><style>
         html,body{margin:0;padding:0;height:100%;
           background:${transparent ? "transparent" : BACKGROUND}}
         /* The SVG's own preserveAspectRatio (xMidYMid meet) letterboxes a
            non-square target — invisible here, since the art is centred in a
            square canvas with dark margin all round. */
         svg{display:block;width:100%;height:100%}
       </style>${sources.get(svg)}`,
    );
    await page.screenshot({ path: out, omitBackground: transparent });
    await page.close();
    console.log(`• ${path.relative(repoRoot, out)} (${width}×${height})`);
  }
} finally {
  await browser.close();
}

// The adaptive icon's background layer is a colour resource, not a raster.
const backgroundXml = path.join(androidRes, "values", "ic_launcher_background.xml");
if (existsSync(backgroundXml)) {
  writeFileSync(
    backgroundXml,
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n` +
      `    <color name="ic_launcher_background">${BACKGROUND.toUpperCase()}</color>\n</resources>\n`,
    "utf8",
  );
  console.log(`• ${path.relative(repoRoot, backgroundXml)} (${BACKGROUND})`);
}

console.log("✓ Icons and splash screens generated.");
