// The visitor's request headers as a demo's app may see them. Cloudflare adds its own cf-* headers to every
// request: CF-Connecting-IP, CF-IPCountry and the rest carry the visitor's address and location, which no app
// needs (each Worker sets X-Forwarded-For itself), and the container library routes on cf-container-target-port,
// which a visitor could otherwise set to reach another port inside the container. The named headers describe
// the visitor's connection, which only the Worker knows; a visitor's X-Forwarded-Host would also let them pick
// the host an app builds its own links from.
//
// Shared by the demo Workers (apps/*/worker); its tests run with the help desk Worker's.

export const STRIPPED_HEADERS = ['forwarded', 'true-client-ip', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip'];

/** The visitor's headers without any cf-* header or the named ones. */
export function forwardableHeaders(headers) {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (!name.startsWith('cf-') && !STRIPPED_HEADERS.includes(name)) out.append(name, value);
  }
  return out;
}
