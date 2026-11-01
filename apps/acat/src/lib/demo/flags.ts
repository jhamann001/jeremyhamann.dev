// Demo switches, server side. DEMO_STAND_INS=on starts the stand-ins for the outside services on
// 127.0.0.1:STAND_INS_PORT, and lets the app's own clients call them over plain http on loopback,
// which they otherwise refuse. demoMode (./mode) is the browser-safe switch for screens and limits.

import { randomBytes } from "node:crypto";

export { demoMode } from "./mode";

export const standInsEnabled = (): boolean => process.env.DEMO_STAND_INS === "on";

export const standInsPort = (): number => Number(process.env.STAND_INS_PORT ?? 8090);

/** True only for an http URL on the stand-ins' own loopback port, and only while stand-ins are on. */
export function isStandInUrl(value: string | URL): boolean {
  if (!standInsEnabled()) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) === standInsPort();
}

// The statement pipeline normally takes a Google-signed identity token. Its stand-in takes this one
// instead: random per process, so only this process's own adapter (gcp-auth.ts) can present it.
// Kept on globalThis because Next bundles instrumentation and route handlers separately, and each
// bundle gets its own copy of this module.
const TOKEN_KEY = Symbol.for("transfer-tracker.standInPipelineToken");
export function standInPipelineToken(): string {
  const store = globalThis as unknown as Record<symbol, string | undefined>;
  store[TOKEN_KEY] ??= randomBytes(32).toString("hex");
  return store[TOKEN_KEY]!;
}
