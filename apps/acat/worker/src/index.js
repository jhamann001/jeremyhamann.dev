// The Transfer Tracker demo at transfers.jeremyhamann.dev: a Worker in front of the app's container.
// It sends http to https, turns away floods per visitor, passes each visitor's IP to the app (its rate
// limits key on it, per persona account and IP), keeps the app's scheduler, machine and MCP endpoints
// private, keeps search engines out, starts each visitor in the portfolio site's theme, and runs the nightly
// reset. The app's built static files are served by Cloudflare without reaching the container (wrangler.jsonc,
// assets).

import { Container, getContainer } from '@cloudflare/containers';
import demoConfig from '../../demo-config.json';
import { cookieTheme, themeRedirect, withTheme } from '../../../demo-edge/theme-handoff.js';
import { forwardableHeaders } from '../../../demo-edge/visitor-headers.js';

// next-themes keeps the theme under its default key (src/app/layout.tsx).
const THEME = { storageKey: 'theme' };

// A key shared only by the app and its own stand-ins inside the container, fresh for each start.
const freshKey = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

export class TransferApp extends Container {
  defaultPort = 3000;
  sleepAfter = '10m';
  // The readiness ping, over plain http inside Cloudflare: the app's public liveness endpoint, which
  // answers without rendering a page or redirecting. The library's start check still calls "/" and
  // follows the sign-in redirect, which is why the app keeps that redirect relative (src/proxy.ts).
  pingEndpoint = 'containerstarthealthcheck/api/health';

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      ...demoConfig,
      NEXTAUTH_URL: env.APP_ORIGIN,
      DATABASE_URL: env.DATABASE_URL,
      NEXTAUTH_SECRET: env.AUTH_SECRET,
      DEMO_RESET_TOKEN: env.DEMO_RESET_TOKEN,
      FEE_STORE_API_KEY: freshKey(),
      CLIENT_DIRECTORY_WAREHOUSE_API_KEY: freshKey(),
      // As with Slack, the webhook's path is its credential.
      SLACK_WEBHOOK_URL: `http://127.0.0.1:${demoConfig.STAND_INS_PORT}/slack/services/T0DEMO/B0DEMO/${freshKey()}`,
    };
  }
}

// No outside caller in the demo: the reset (run by the cron below), the scheduled jobs, the machine API
// for the firm's other systems, and the Claude MCP server with its OAuth endpoints (off; the MCP page
// explains why).
const PRIVATE_PATHS = /^\/(api\/(internal|machine|cron|mcp)(\/|$)|mcp\/oauth(\/|$)|\.well-known\/oauth-)/;

// Who a visitor is, for rate limits: the IPv4 address, or for IPv6 the /64 network. One connection gets
// a whole /64, so keying on the full address would let a visitor pick a new bucket for every request.
export function visitorKey(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (g || '0').toLowerCase()).join(':')}::/64`;
}

// The path as the app's router will see it: percent-decoded, with repeated slashes collapsed and in lower
// case, so an encoded or doubled spelling can't slip a private path past the check. Null if malformed.
function routedPath(pathname) {
  try {
    return decodeURIComponent(pathname).replace(/\/{2,}/g, '/').toLowerCase();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const handoff = themeRedirect(request);
    if (handoff) return handoff;
    const path = routedPath(url.pathname);
    if (path === null) return new Response('Bad request', { status: 400 });
    if (PRIVATE_PATHS.test(path)) return new Response('Not found', { status: 404 });

    const visitor = visitorKey(request.headers.get('CF-Connecting-IP') ?? '');
    const { success } = await env.VISITOR_LIMIT.limit({ key: visitor });
    if (!success) {
      return new Response('Too many requests. Please wait a minute.', { status: 429, headers: { 'retry-after': '60' } });
    }

    // Overwrite, never append: the app keys its rate limits on this header, and a value the browser sent
    // would let anyone pick their own bucket.
    // Without Cloudflare's own cf-* headers (the visitor's address among them) or a visitor's forwarding headers.
    const headers = forwardableHeaders(request.headers);
    headers.set('X-Forwarded-For', visitor);
    headers.set('X-Forwarded-Proto', 'https');
    const response = await getContainer(env.TRANSFER_APP).fetch(new Request(request, { headers }));

    const out = new Response(response.body, response);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    const theme = cookieTheme(request);
    return theme ? withTheme(out, theme, THEME) : out;
  },

  // Nightly at 07:00 UTC (3 AM Eastern in summer, 2 AM in winter): reseed the demo and rerun its jobs
  // (src/lib/demo/reset.ts).
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(resetDemo(env));
  },
};

// One retry, a minute later: the first request wakes both the sleeping container and the database.
async function resetDemo(env) {
  try {
    await requestReset(env);
  } catch (error) {
    console.warn(`demo reset failed, retrying in 60 s: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    await requestReset(env);
  }
}

async function requestReset(env) {
  const request = new Request(`${env.APP_ORIGIN}/api/internal/demo-reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.DEMO_RESET_TOKEN}`, 'x-forwarded-proto': 'https' },
    redirect: 'manual',
  });
  const response = await getContainer(env.TRANSFER_APP).fetch(request);
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 300)}`);
  console.log(`demo reset complete: ${body.slice(0, 500)}`);
}
