// The Statement Analyzer demo at statements.jeremyhamann.dev: a Worker in front of the app's container. It sends
// http to https, turns away floods per visitor and oversized requests, passes the app a pseudonym for each visitor
// (its sample-run limit keys on it), keeps the app's scheduler, machine and MCP endpoints private, keeps search
// engines out, puts the pages under a Content-Security-Policy, starts each visitor in the portfolio site's theme,
// and runs the nightly reset. The app's built scripts and styles are served by Cloudflare without reaching the
// container (wrangler.jsonc, assets).

import { Container, getContainer } from '@cloudflare/containers';
import demoConfig from '../../demo-config.json';
import { cookieTheme, themeRedirect, withTheme } from '../../../demo-edge/theme-handoff.js';
import { retireStaleContainer } from './container-settings.js';
import {
  bodyWithinLimit,
  forwardableHeaders,
  PRIVATE_PATHS,
  routedPath,
  visitorKey,
  visitorPseudonym,
  withDemoHeaders,
} from './rules.js';

// The app's theme script reads this key before the page paints (frontend/public/theme.js).
const THEME = { storageKey: 'theme' };

// Used only if the deploy's VISITOR_HASH_KEY is missing: pseudonyms then change per isolate, never fall back to IPs.
// Made on first use, since Workers refuse random values at global scope (the upload fails with code 10021).
let isolateKey;
const fallbackHashKey = () => (isolateKey ??= crypto.randomUUID());

export class StatementsApp extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';
  // The readiness ping, over plain http inside Cloudflare: the app's public health endpoint (any answer counts).
  pingEndpoint = 'containerstarthealthcheck/api/health';

  constructor(ctx, env) {
    super(ctx, env);
    // Everything the container is started with, so a container started by an earlier deploy is retired
    // (container-settings.js).
    this.deploySettings = {
      ...demoConfig,
      DATABASE_URL: env.DATABASE_URL,
      SESSION_SECRET: env.SESSION_SECRET,
      DEMO_RESET_TOKEN: env.DEMO_RESET_TOKEN,
    };
    this.envVars = this.deploySettings;
  }

  async fetch(request) {
    // Once per object, shared by the requests that arrive while it runs; a failure is retried by the next request.
    this.settingsChecked ??= retireStaleContainer({
      container: this.container,
      storage: this.ctx.storage,
      settings: this.deploySettings,
      destroy: () => this.destroy(),
    }).catch((error) => {
      this.settingsChecked = undefined;
      throw error;
    });
    await this.settingsChecked;
    return super.fetch(request);
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
    if (!bodyWithinLimit(request)) return new Response('Request too large', { status: 413 });

    const visitor = visitorKey(request.headers.get('CF-Connecting-IP') ?? '');
    const { success } = await env.VISITOR_LIMIT.limit({ key: visitor });
    if (!success) {
      return new Response('Too many requests. Please wait a minute.', { status: 429, headers: { 'retry-after': '60' } });
    }

    // Overwrite, never append: the app keys its sample-run limit on this header, and a value the browser sent
    // would let anyone pick their own bucket.
    const headers = forwardableHeaders(request.headers);
    headers.set('X-Forwarded-For', await visitorPseudonym(visitor, env.VISITOR_HASH_KEY ?? fallbackHashKey()));
    headers.set('X-Forwarded-Proto', 'https');
    const response = await getContainer(env.STATEMENTS_APP).fetch(new Request(request, { headers }));

    // The policy goes on first, so the theme line's hash is added to it.
    const out = withDemoHeaders(response);
    const theme = cookieTheme(request);
    return theme ? withTheme(out, theme, THEME) : out;
  },

  // Nightly at 07:00 UTC (3 AM Eastern in summer, 2 AM in winter): reseed the demo (demo_reset.py).
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(resetDemo(env));
  },
};

// One retry, a minute later: the first request wakes both the sleeping container and the database.
export async function resetDemo(env, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  try {
    await requestReset(env);
  } catch (error) {
    console.warn(`demo reset failed, retrying in 60 s: ${error.message}`);
    await wait(60_000);
    await requestReset(env);
  }
}

async function requestReset(env) {
  const request = new Request(`${env.APP_ORIGIN}/api/internal/demo-reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.DEMO_RESET_TOKEN}`, 'x-forwarded-proto': 'https' },
    redirect: 'manual',
  });
  const response = await getContainer(env.STATEMENTS_APP).fetch(request);
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 300)}`);
  console.log(`demo reset complete: ${body.slice(0, 500)}`);
}
