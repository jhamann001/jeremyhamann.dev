"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

/** Client-side context for the whole app: React Query, theme, tooltips, toasts. */
export function Providers({ children }: { children: React.ReactNode }): React.JSX.Element {
  // One QueryClient per browser session; useState keeps it stable across re-renders and avoids
  // sharing a client between requests during SSR.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: 1 },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider delayDuration={200}>
          {children}
          {/* No breakpoint hook (MOBILE_FIRST D10): Sonner already renders toasts full-width at the top below
              600px; mobileOffset just clears the compact phone topbar (20px banner + 44px row) and the notch. */}
          <Toaster
            richColors
            position="top-right"
            closeButton
            mobileOffset={{ top: "calc(env(safe-area-inset-top, 0px) + 4.5rem)" }}
          />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
