import type { Metadata } from "next";
import { Geist, Geist_Mono, Playfair_Display } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import SessionProvider from "@/components/SessionProvider";
import ThemeProvider from "@/components/ThemeProvider";
import { ToastProvider } from "@/components/Toast";
import { CustodianEditingRetirementProvider } from "@/components/CustodianEditingRetirement";
import { trackerCustodianEditsRetired } from "@/lib/custodian-admin";
import SWRProvider from "@/components/SWRProvider";
import PresenceTracker from "@/components/PresenceTracker";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const playfair = Playfair_Display({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Transfer Tracker & Recon Engine",
  description: "Internal transfer-trackerciliation tool — Cedar Ridge Wealth",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Proxy (src/proxy.ts) sets `x-nonce` on the forwarded request
  // for HTML responses. Propagate it to next-themes so its inline theme
  // bootstrap script carries the matching nonce — without this, strict
  // CSP blocks the script and the page flashes light-theme before hydration.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${playfair.variable} h-full antialiased`}
    >
      <body className="h-full">
        <ThemeProvider
          attribute="data-theme"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
          nonce={nonce}
        >
          <SessionProvider>
            <SWRProvider>
              <PresenceTracker />
              <CustodianEditingRetirementProvider retired={trackerCustodianEditsRetired()}>
                <ToastProvider>{children}</ToastProvider>
              </CustodianEditingRetirementProvider>
            </SWRProvider>
          </SessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
