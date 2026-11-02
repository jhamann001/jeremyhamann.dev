// The nightly reset's "resetting" page. The reset empties the database and fills it again over a few minutes
// (scripts/demo-seed.ts); meanwhile a visitor would see a half-filled demo, so the reset job puts this page up first
// and takes it down when the seed is in. It comes down by itself when its time runs out, so a reset that dies
// can't leave it up. The job proves itself with RESET_GATE_TOKEN, which the deploy and the job both derive from the
// database owner's password (lib/demo/logins.ts, demoResetGateToken). The state lives in one Durable Object
// (ResetGate in index.js); everything here is plain logic, tested in Node.

export const GATE_PATH = '/__demo/reset-gate';
export const MAX_GATE_MINUTES = 60;

/** Compares two tokens in constant time for their length; an empty expected token never matches. */
export function tokensMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

/**
 * A request to the gate: POST with `Authorization: Bearer <token>` and `{"minutes": n}`, n from 0 (take the page
 * down) to MAX_GATE_MINUTES. Returns the change, or the status to refuse it with.
 */
export async function readGateChange(request, token) {
  // The token first: to anyone without it, the gate isn't there at all.
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!tokensMatch(given, token ?? '')) return { ok: false, status: 404 };
  if (request.method !== 'POST') return { ok: false, status: 405 };
  let body;
  try {
    body = await request.json();
  } catch {
    return { ok: false, status: 400 };
  }
  const minutes = body?.minutes;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_GATE_MINUTES) return { ok: false, status: 400 };
  return { ok: true, minutes };
}

/**
 * Until when the page is up, from `read` (the Durable Object), or 0 (down) when it can't be read: every request
 * asks, so a broken gate must not turn the whole demo into errors. Logs a static marker only.
 */
export async function gateUntilOrOpen(read) {
  try {
    return await read();
  } catch {
    console.error('[aoa-gate] gate_read_failed');
    return 0;
  }
}

/** Until when the page stays up for a change made at `now` (0: down). */
export const gateUntil = (minutes, now) => (minutes === 0 ? 0 : now + minutes * 60_000);

/** Whether a request should see the page: everything while it's up, except the liveness check. */
export const showsResettingPage = (until, now, path) => until > now && path !== '/api/health';

/** The page itself: a 503 that refreshes itself, so the visitor lands in the fresh demo without doing anything. */
export function resettingResponse(portfolioUrl = 'https://jeremyhamann.dev') {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<meta name="robots" content="noindex">
<title>Resetting the demo · Always-On Advice</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f1ea; --fg: #1c1a16; --muted: #6c6457; --accent: #2f5d4d; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14110c; --fg: #ece7df; --muted: #8d857a; --accent: #5a9b82; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; box-sizing: border-box; }
  main { max-width: 34rem; }
  h1 { font: 600 1.6rem/1.25 Georgia, "Iowan Old Style", serif; margin: 0 0 12px; }
  p { margin: 0 0 10px; color: var(--muted); }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>The demo is resetting</h1>
  <p>Every night the demo goes back to fresh data: every household, transfer and request as it was, dated to today.
     It takes a few minutes. This page reloads by itself and opens the demo when it's ready.</p>
  <p><a href="${portfolioUrl}">Back to jeremyhamann.dev</a></p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '60',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
