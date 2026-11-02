// NEXT_PUBLIC_DEMO_MODE=on turns on the public demo: its banner, the Outbox, the machine routes' refusals, and
// outbound messages captured instead of sent. Read in the browser as well as on the server, so it is set at build
// time and at run time (demo-config.json). Persona sign-in follows PERSONA_SIGN_IN (./personas). Safe to import from
// client code.

export const demoMode = (): boolean => process.env.NEXT_PUBLIC_DEMO_MODE === "on";

/** The portfolio site the demo is shown from (NEXT_PUBLIC_PORTFOLIO_URL), or null outside the demo image. */
export function portfolioLink(): { url: string; site: string } | null {
  const url = process.env.NEXT_PUBLIC_PORTFOLIO_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? { url: parsed.href, site: parsed.host } : null;
  } catch {
    return null;
  }
}
