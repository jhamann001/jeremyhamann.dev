"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, Monitor } from "lucide-react";

type ThemeToggleProps = {
  className?: string;
  size?: number;
};

// Returns false during SSR and true after hydration without an effect,
// so the active-state icon matches between server and client.
const subscribeNoop = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Tri-state theme toggle: light -> dark -> system -> light.
 */
export default function ThemeToggle({ className = "", size = 16 }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribeNoop,
    getClientSnapshot,
    getServerSnapshot,
  );

  const current = mounted ? theme ?? "system" : "system";

  const next =
    current === "light" ? "dark" : current === "dark" ? "system" : "light";

  const label =
    current === "light"
      ? "Switch to dark theme"
      : current === "dark"
        ? "Switch to system theme"
        : "Switch to light theme";

  const Icon =
    current === "light" ? Sun : current === "dark" ? Moon : Monitor;

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
      data-theme-state={current}
      suppressHydrationWarning
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-card-border bg-[var(--bg-card)] text-foreground transition hover:bg-[var(--bg-hover)] focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-[var(--bg)] ${className}`}
    >
      <Icon size={size} />
    </button>
  );
}
