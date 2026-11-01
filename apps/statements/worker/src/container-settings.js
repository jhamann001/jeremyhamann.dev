// A running container keeps the environment it was started with, and after a deploy the new Durable Object attaches
// to it rather than starting it again (@cloudflare/containers passes envVars only at start). Each deploy makes a new
// reset token, so a container left running from the previous deploy would refuse the nightly reset, and a changed
// database or session secret would never reach it. The Durable Object records which settings it started the
// container with, and retires a container started with any others before its first request.
//
// The same as the help desk Worker's (apps/helpdesk/worker/src/container-settings.js).

export const STARTED_WITH_KEY = 'startedWithSettings';

// A digest, so no secret is written to storage.
export async function settingsFingerprint(settings) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(settings)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Stops a running container started with other settings (or before they were recorded), and records the settings
// the next start will use. Returns true when it stopped one. If stopping fails nothing is recorded, so the next
// request tries again.
export async function retireStaleContainer({ container, storage, settings, destroy }) {
  const current = await settingsFingerprint(settings);
  if (container.running && (await storage.get(STARTED_WITH_KEY)) === current) return false;
  const stale = container.running;
  if (stale) await destroy();
  await storage.put(STARTED_WITH_KEY, current);
  return stale;
}
