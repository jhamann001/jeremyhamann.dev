/**
 * The demo switch. `NEXT_PUBLIC_DEMO_MODE=on` turns on the demo's stand-ins for outside services, its
 * Outbox screen, the demo AI provider and the upload refusal. It is read in the browser as well as on the
 * server (the navigation is built client-side), so it is set at build time and at run time. Never on
 * where `APP_ENV=production`: a real deployment cannot be talked into sending its mail to a stand-in.
 *
 * Safe to import from client code.
 */
export const demoMode = (): boolean =>
  process.env.NEXT_PUBLIC_DEMO_MODE === "on" && process.env.APP_ENV !== "production";

/**
 * The demo's longest free text (descriptions, replies, notes, drafts): what a visitor writes stays in the shared
 * database until the reset, so each piece is kept short. The app's own maximum elsewhere.
 */
export const DEMO_TEXT_MAX = 4_000;
export const demoTextMax = (max: number): number => (demoMode() ? Math.min(max, DEMO_TEXT_MAX) : max);

/** The loopback port the stand-ins listen on inside the container. Nothing outside can connect. */
export const standInsPort = (): number => {
  const raw = Number(process.env.STAND_INS_PORT ?? 8090);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 8090;
};

/** The app's own port, for the stand-ins that call its API over loopback the way the real workflows do. */
export const appPort = (): number => {
  const raw = Number(process.env.PORT ?? 3000);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 3000;
};

/**
 * Whether `raw` is a stand-in address: plain http to 127.0.0.1 on the stand-ins' port, in demo mode only.
 * The Slack settings accept this beside the https addresses they otherwise require, so the source's own
 * Slack client posts to the stand-in unchanged.
 */
export function isStandInUrl(raw: string): boolean {
  if (!demoMode()) return false;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) === standInsPort();
  } catch {
    return false;
  }
}

/** The line the attachments panel and the refused upload both show in demo mode. */
export const DEMO_UPLOADS_OFF = "Uploads are off in this demo. The attached files are generated samples.";

/** Why the API tokens page issues nothing in the demo: the routes a token opens are closed at the edge. */
export const DEMO_TOKENS_OFF =
  "API tokens are off in this demo: the client API, MCP and machine routes a token would open are closed at its edge.";
