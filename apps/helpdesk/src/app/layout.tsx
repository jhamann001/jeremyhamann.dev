import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * the installable-app metadata.
 *
 * The manifest and the icons are DECLARED here, by the foundation, and PRODUCED by B10
 * (`tools/pwa/**` writes `public/icons/*.png` with a `node:zlib` PNG encoder — no new dependency).
 * Declaring them first is deliberate: the links are a shared-file change, the files are a slice's, and
 * separating the two is what stops four slices editing one layout.
 *
 * Until B10 lands the three paths 404, which a browser treats as "not installable" and nothing else —
 * no console error a user sees, no broken render. `public/manifest.webmanifest`, `public/icons/**`,
 * `public/sw.js` and `public/offline.html` are generated files that are nevertheless COMMITTED: a
 * build must not depend on a generator having been run, and a missing icon is a silent 404 rather
 * than a loud failure.
 *
 * `appleWebApp` is what gives iOS a standalone window and a status-bar style; iOS ignores the manifest
 * for both. `themeColor` lives on `viewport`, not here — Next moved it, and declaring it in `metadata`
 * is a build-time warning.
 */
export const metadata: Metadata = {
  title: "WM Help Desk",
  description: "Wealth management help desk",
  applicationName: "WM Help Desk",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "WM Help Desk", statusBarStyle: "default" },
  // A staff desk is never a search result and never a link preview: both would be a record leaking
  // into somebody else's index. `nocache` additionally keeps an archiver from storing a rendered page.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * `viewportFit: "cover"` makes `env(safe-area-inset-*)` non-zero on iOS (every bottom bar and sheet footer
 * pads by it); `interactiveWidget: "resizes-content"` keeps fixed bars above the Android keyboard.
 * `maximumScale` is deliberately not set — pinch zoom stays available (WCAG 1.4.4). docs/MOBILE_FIRST.md R5.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  // the installed window's chrome, per theme. Declared here because Next reads `themeColor`
  // from `viewport` and warns when it is in `metadata`.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    // suppressHydrationWarning: next-themes sets the `class` attribute before hydration.
    // The Geist variables live on <html>: globals.css binds `--font-sans` on :root to `--font-geist-sans`, and a
    // custom property is resolved on the element that declares it — declared on <body> the variable is undefined
    // at :root, `--font-sans` becomes invalid and the whole app falls back to the UA serif.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="min-h-svh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
