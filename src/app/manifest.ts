import type { MetadataRoute } from "next";
import { BRAND_NAME } from "@/lib/brand";

/**
 * Web app manifest. Serves two purposes: installable PWA on the web, and the
 * canonical source for the icon art the native builds are generated from
 * (`pnpm native:assets` renders both from native/assets/icon.svg).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    description: "AI-native whiskey tracking: your bar, your palate, your pours.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d1410",
    theme_color: "#0d1410",
    orientation: "portrait",
    categories: ["food", "lifestyle"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Log a pour", url: "/pour" },
      { name: "Scan a bottle", url: "/scan" },
    ],
  };
}
