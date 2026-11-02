export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Cookie that persists the chosen theme (server-readable → no-flash SSR). The demo's Worker sets it too, from the
 * portfolio site's ?theme= (apps/demo-edge/theme-handoff.js). */
export const THEME_COOKIE = "theme";

/** Resolve a cookie value to a theme. Light is the default. */
export function resolveTheme(value: string | undefined): Theme {
  return value === "dark" ? "dark" : "light";
}
