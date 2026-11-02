/**
 * Emergency/maintenance write gate. The value is read per request so a new
 * Cloud Run revision can put canonical dev into read-only mode without a code
 * change. Any non-empty value except `false` or `0` fails closed.
 */
export function appWritesPaused(): boolean {
  const value = process.env.AOA_WRITES_PAUSED?.trim().toLowerCase();
  return Boolean(value && value !== "false" && value !== "0");
}
