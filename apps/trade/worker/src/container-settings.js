// A running container keeps the environment it was started with, and after a deploy the new Durable Object attaches
// to it rather than starting it again (@cloudflare/containers passes envVars only at start). A deploy may change the database
// or session secret or the demo settings (index.js, deploySettings), which would never reach a container left running
// from the previous deploy. The Durable Object records which settings it started the container with, and retires a
// container started with any others before its first request. Each deploy's Worker version is one of the settings,
// so each deploy gets a container of its own, which its deploy check waits for (demo-edge/container-start.js).
//
// The same logic as the help desk Worker's (apps/helpdesk/worker/src/container-settings.js).

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
