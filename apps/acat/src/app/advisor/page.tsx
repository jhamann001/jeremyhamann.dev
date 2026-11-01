"use client";

import { useState } from "react";
import { LogOut, RefreshCw } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import AdvisorTransfersView from "@/components/AdvisorTransfersView";
import { useAdvisorAcats } from "@/hooks/use-advisor-acats";
import { PortfolioIconLink, PortfolioLink } from "@/components/PortfolioLink";

// ticket: Advisor self-service transfer status page.
//
// Lives outside the ops `NavRail` layout — advisors don't have access
// to dashboard / records / admin and shouldn't see those nav targets
// at all. The chrome is intentionally minimal: identity + sign out +
// refresh, nothing more.

export default function AdvisorPage() {
  const { data: session } = useSession();
  const { acats, loading, error, refresh } = useAdvisorAcats();
  const [refreshing, setRefreshing] = useState(false);
  // Track only manual refreshes — derived auto-refresh timestamps
  // would need an effect that calls Date.now(), which the React 19
  // purity lint correctly rejects. Background SWR polls happen
  // silently every 60s; the explicit refresh button is what the user
  // gets feedback for.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
      setLastRefreshedAt(Date.now());
    } finally {
      setRefreshing(false);
    }
  };

  const userLabel = session?.user?.name ?? session?.user?.email ?? "Advisor";

  return (
    <div className="flex h-screen flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-card-border bg-sidebar-bg px-6 py-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--invert-bg)] text-[var(--invert-text)] shadow-sm"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            <span className="text-base font-semibold leading-none">C</span>
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-foreground">
              Cedar Ridge Wealth
            </p>
            <p className="text-[11px] uppercase tracking-wide text-muted-faint">
              Advisor portal
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="mr-1 hidden sm:inline-flex">
            <PortfolioLink />
          </span>
          <PortfolioIconLink className="sm:hidden" />
          <span className="hidden text-xs text-muted sm:inline">
            {userLabel}
          </span>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw
              size={14}
              className={refreshing ? "animate-spin" : undefined}
            />
          </button>
          <button
            type="button"
            onClick={() => signOut()}
            aria-label="Sign out"
            title="Sign out"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-card-border text-muted transition hover:text-foreground"
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      <main className="flex-1 overflow-hidden">
        <AdvisorTransfersView
          acats={acats}
          loading={loading}
          error={error}
          lastRefreshedAt={lastRefreshedAt}
        />
      </main>
    </div>
  );
}
