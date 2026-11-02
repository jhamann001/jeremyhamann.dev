"use client";

import { THEME_COOKIE } from "@/lib/theme";

/**
 * Flips light/dark by toggling the `dark` class on <html> and persisting the
 * choice to the theme cookie (read server-side on next load for no-flash).
 * A1 mounts this on the landing page; A3 relocates it into the top bar.
 */
export function ThemeToggle() {
  function toggle() {
    const isDark = document.documentElement.classList.toggle("dark");
    const secure = location.protocol === "https:" ? ";secure" : "";
    document.cookie = `${THEME_COOKIE}=${isDark ? "dark" : "light"};path=/;max-age=31536000;samesite=lax${secure}`;
  }
  return (
    <button className="btn" type="button" onClick={toggle} aria-label="Toggle color theme">
      Theme
    </button>
  );
}
