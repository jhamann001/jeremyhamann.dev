"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import { useIdleTimeout } from "@/hooks/use-idle-timeout";
import { Clock } from "lucide-react";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function IdleGuard({ children }: { children: React.ReactNode }) {
  const { showWarning, secondsLeft, staySignedIn } = useIdleTimeout();

  return (
    <>
      {children}
      {showWarning && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--panel-backdrop)] backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-card-border bg-[var(--bg-card)] p-8 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--warning-bg)]">
                <Clock size={20} className="text-[color:var(--warning)]" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">
                Session Expiring
              </h2>
            </div>
            <p className="mb-2 text-sm text-muted">
              You&apos;ll be signed out due to inactivity in
            </p>
            <p className="mb-6 text-3xl font-bold tabular-nums text-[color:var(--warning)]">
              {formatTime(secondsLeft)}
            </p>
            <button
              onClick={staySignedIn}
              className="w-full rounded-xl bg-[var(--invert-bg)] px-5 py-3 text-sm font-semibold text-[var(--invert-text)] transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
            >
              Stay Signed In
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function SessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <NextAuthSessionProvider>
      <IdleGuard>{children}</IdleGuard>
    </NextAuthSessionProvider>
  );
}
