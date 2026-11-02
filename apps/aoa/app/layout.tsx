import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { cookies } from "next/headers";
import localFont from "next/font/local";
import { resolveTheme, THEME_COOKIE } from "@/lib/theme";
import { ChunkReloader } from "@/components/ChunkReloader";
import { EnvBanner } from "@/components/shell/EnvBanner";
import { DemoBanner, DEMO_BANNER_HEIGHT } from "@/components/demo/DemoBanner";
import { demoMode } from "@/lib/demo/mode";
import "./globals.css";

// Pinned original files; licenses and provenance: /fonts/NOTICE.txt.
// Keep Google's original Newsreader subsets: author static builds have different
// spacing. Separate faces retain unicode ranges and Latin-only preloading.
const serif = localFont({
  src: [
    { path: "./fonts/Newsreader-Latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Newsreader-Latin.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Newsreader-Latin.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-serif-latin", display: "swap", adjustFontFallback: "Times New Roman",
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
});
const serifExtended = localFont({
  src: [
    { path: "./fonts/Newsreader-LatinExt.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Newsreader-LatinExt.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Newsreader-LatinExt.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-serif-extended", display: "swap", adjustFontFallback: false, preload: false,
  declarations: [{ prop: "unicode-range", value: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" }],
});
const serifVietnamese = localFont({
  src: [
    { path: "./fonts/Newsreader-Vietnamese.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Newsreader-Vietnamese.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Newsreader-Vietnamese.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-serif-vietnamese", display: "swap", adjustFontFallback: false, preload: false,
  declarations: [{ prop: "unicode-range", value: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" }],
});
const sans = localFont({
  src: [
    { path: "./fonts/Heebo-Variable.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Heebo-Variable.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Heebo-Variable.woff2", weight: "600", style: "normal" },
    { path: "./fonts/Heebo-Variable.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-sans", display: "swap", adjustFontFallback: "Arial",
});
const mono = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexMono-SemiBold.ttf", weight: "600", style: "normal" },
  ],
  variable: "--font-mono", display: "swap", adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: "Always-On Advice",
  description: "Cedar Ridge Wealth firm operating system",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read the theme cookie server-side so the correct class is set on first paint
  // (no flash-of-wrong-theme). Light is the default (no class).
  const theme = resolveTheme((await cookies()).get(THEME_COOKIE)?.value);
  const htmlClass = [theme === "dark" ? "dark" : "", serif.variable, serifExtended.variable, serifVietnamese.variable, sans.variable, mono.variable]
    .filter(Boolean)
    .join(" ");
  // Secondary subsets must precede the Latin face's generated system fallback.
  // The public --font-serif contract stays unchanged for every existing view.
  const fontVariables = {
    "--font-serif": "var(--font-serif-extended), var(--font-serif-vietnamese), var(--font-serif-latin)",
    // The full-height shell and sign-in screen subtract the demo banner's height.
    ...(demoMode() ? { "--demo-banner-height": DEMO_BANNER_HEIGHT } : {}),
  } as CSSProperties;
  return (
    <html lang="en" className={htmlClass} style={fontVariables}>
      <body>
        <ChunkReloader />
        <EnvBanner />
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
