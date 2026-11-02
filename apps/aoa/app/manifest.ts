import type { MetadataRoute } from "next";

// Web app manifest (served at /manifest.webmanifest). The icon PNGs referenced
// here are generated from app/icon.svg by scripts/generate-icons.mjs.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Always-On Advice",
    short_name: "AOA",
    description: "Cedar Ridge Wealth firm operating system",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
