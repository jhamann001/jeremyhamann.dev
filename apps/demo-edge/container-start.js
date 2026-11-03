// While a demo's container starts. Each demo runs one container, and a deploy replaces it: Cloudflare stops the old
// one before it starts the new image, so for a minute or two there is none. A request then got @cloudflare/containers'
// own error text after its 8-second wait (a 503 "There is no Container instance available…" or a 500 "Failed to
// start container: …"), passed straight to the visitor. A container waking from its sleep takes about 20 seconds and
// usually starts within that wait.
//
//   - fetchWhenStarted asks again, for up to 15 seconds, when a page load (GET or HEAD) meets one of those answers,
//     then serves a page that says the demo is starting and reloads itself every 5 seconds. Anything else gets a
//     short JSON 503 at once: a write is never sent twice.
//   - The deploy check: /__demo/started, keyed by the version the deploy just made, starts that deploy's container
//     and answers when it is up (startContainerForDeploy, in the Durable Object), so a deploy reports itself live only once
//     its own container answers (wait-for-deploy.mjs). To anyone without the key the path isn't there.
//
// Shared by the demo Workers (apps/*/worker); its tests run with the help desk Worker's.

import { cookieTheme } from './theme-handoff.js';

export const STARTED_PATH = '/__demo/started';
export const RETRY_FOR_MS = 15_000;
const PAUSE_MS = 1_500;
const RELOAD_SECONDS = 5;
const PORTFOLIO = 'https://jeremyhamann.dev';

// The library's answers when it could not reach a container: their status and how their text starts.
const START_FAILURES = [
  [503, 'There is no Container instance available'],
  [500, 'Failed to start container'],
  [500, 'Container suddenly disconnected'],
  [500, 'Error proxying request to container'],
];

/** Whether a response is the library's own "no container" answer, not something the app said. */
export async function isStartFailure(response) {
  const starts = START_FAILURES.filter(([status]) => status === response.status).map(([, text]) => text);
  if (starts.length === 0) return false;
  const text = await response.clone().text();
  return starts.some((start) => text.startsWith(start));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startingResponses = new WeakSet();

/** Whether a response is the starting page or its JSON, which the Worker returns as it is. */
export const isStartingResponse = (response) => startingResponses.has(response);

/**
 * The container's answer to `request`, or, while the container can't be reached, the starting page. `demo` names
 * the demo on that page: `{ name, accent: [light, dark] }`.
 */
export async function fetchWhenStarted(container, request, demo, { now = Date.now, wait = sleep } = {}) {
  const resend = request.method === 'GET' || request.method === 'HEAD';
  const begun = now();
  for (;;) {
    let failure;
    try {
      // A fresh copy each time, since a request is sent once; only GET and HEAD, which carry no body, go again.
      const response = await container.fetch(resend ? new Request(request) : request);
      if (!(await isStartFailure(response))) return response;
      failure = String(response.status);
    } catch (error) {
      // The object itself can fail while the container starts, as when a deploy resets it.
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!resend || now() - begun >= RETRY_FOR_MS) {
      console.warn(`[demo-edge] container_not_started ${failure.slice(0, 120)}`);
      return startingResponse(request, demo);
    }
    await wait(PAUSE_MS);
  }
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The starting page for a page load, else a short JSON 503. Both say when to try again. */
export function startingResponse(request, demo) {
  const headers = {
    'cache-control': 'no-store',
    'retry-after': String(RELOAD_SECONDS),
    'x-robots-tag': 'noindex, nofollow',
  };
  const page = request.headers.get('sec-fetch-dest') === 'document' || (request.headers.get('accept') ?? '').includes('text/html');
  const response = page
    ? new Response(startingPage(request, demo), {
        status: 503,
        headers: {
          ...headers,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'strict-transport-security': 'max-age=63072000; includeSubDomains',
          'x-content-type-options': 'nosniff',
        },
      })
    : Response.json({ error: 'starting', message: 'The demo is starting up. Try again in a few seconds.' }, { status: 503, headers });
  startingResponses.add(response);
  return response;
}

function startingPage(request, demo) {
  const url = new URL(request.url);
  // Where to try again: this page for a GET, the demo's front page after anything else. One leading slash, so a
  // path such as //example.com can't make the reload leave the demo.
  const again = escapeHtml(request.method === 'GET' ? `/${(url.pathname + url.search).replace(/^\/+/, '')}` : '/');
  const theme = cookieTheme(request);
  const name = escapeHtml(demo.name);
  const [light, dark] = demo.accent;
  return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RELOAD_SECONDS};url=${again}">
<meta name="robots" content="noindex">
<title>Starting up · ${name}</title>
<style>
  :root { color-scheme: light; --bg: #FFFFFF; --surface: #FFFFFF; --border: #E4E4E7; --fg: #09090B; --fg-2: #3F3F46; --fg-3: #63636B; --accent: ${light}; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { color-scheme: dark; --bg: #09090B; --surface: #111114; --border: #27272A; --fg: #FAFAFA; --fg-2: #D4D4D8; --fg-3: #B4B4BD; --accent: ${dark}; }
  }
  :root[data-theme="dark"] { color-scheme: dark; --bg: #09090B; --surface: #111114; --border: #27272A; --fg: #FAFAFA; --fg-2: #D4D4D8; --fg-3: #B4B4BD; --accent: ${dark}; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased;
         padding: 20px max(16px, env(safe-area-inset-right, 0px)) 32px max(16px, env(safe-area-inset-left, 0px)); }
  p { margin: 0; }
  .back { align-self: flex-start; font-size: 13px; color: var(--fg-3); text-decoration: none; border: 1px solid var(--border);
          border-radius: 999px; padding: 5px 12px; background: var(--surface); }
  .back:hover { color: var(--fg); }
  main { flex: 1; display: grid; place-items: center; }
  .card { width: 100%; max-width: 440px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 28px 28px 24px; }
  .demo { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: var(--fg-2); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  h1 { margin: 14px 0 6px; font-size: 22px; line-height: 1.25; letter-spacing: -.02em; text-wrap: balance; }
  .lead { color: var(--fg-2); }
  .status { display: flex; align-items: center; gap: 10px; margin-top: 20px; font-size: 13px; color: var(--fg-3); }
  .spinner { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: spin .9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; width: 8px; height: 8px; border: 0; background: var(--accent); } }
  .btn { display: inline-block; margin-top: 18px; font-size: 13.5px; font-weight: 500; color: var(--bg); background: var(--fg);
         border-radius: 8px; padding: 8px 14px; text-decoration: none; }
</style>
</head>
<body>
<a class="back" href="${PORTFOLIO}">← Back to jeremyhamann.dev</a>
<main>
  <section class="card">
    <p class="demo"><span class="dot" aria-hidden="true"></span>${name}</p>
    <h1>The demo is starting up</h1>
    <p class="lead">Its server was asleep or has just been updated. This usually takes under a minute, and this page tries again on its own.</p>
    <p class="status"><span class="spinner" aria-hidden="true"></span>Trying again every ${RELOAD_SECONDS} seconds…</p>
    <a class="btn" href="${again}">Try now</a>
  </section>
</main>
</body>
</html>`;
}

/** Compares two strings in constant time for their length; an empty expected value never matches. */
function sameKey(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

/**
 * The deploy check's answer: 200 once this deploy's container is up, 503 while it can't be started yet, and 404
 * unless `?version=` is this Worker's own version (an older version still answering doesn't know it either).
 */
export async function startedResponse(request, env, container) {
  const headers = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };
  if (request.method !== 'GET' || !sameKey(new URL(request.url).searchParams.get('version'), env.CF_VERSION_METADATA?.id)) {
    return new Response('Not found', { status: 404, headers });
  }
  try {
    const { startedMs } = await container.startForDeploy();
    return Response.json({ ready: true, startedMs }, { headers });
  } catch (error) {
    console.warn(`[demo-edge] deploy_check_not_started ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
    return Response.json({ ready: false }, { status: 503, headers: { ...headers, 'retry-after': '10' } });
  }
}

/**
 * The deploy check's half inside the Durable Object: starts the container, waiting far longer than a visitor's
 * request would, since the image a deploy just pushed can take minutes to reach the container's location.
 */
export async function startContainerForDeploy(app, { now = Date.now } = {}) {
  const begun = now();
  await app.startAndWaitForPorts({ cancellationOptions: { instanceGetTimeoutMS: 90_000, portReadyTimeoutMS: 120_000 } });
  return { startedMs: now() - begun };
}
