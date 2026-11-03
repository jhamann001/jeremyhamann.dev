// The advisor platform demo at aoa.jeremyhamann.dev: a Worker in front of the app's container. It sends http to
// https, starts each visitor in the portfolio site's theme, keeps the app's machine endpoints private, turns away
// floods and oversized requests per visitor (with a stricter limit on writes), passes the app a pseudonym for each
// visitor's address, lets the portfolio's analytics beacon run, keeps search engines out, shows the "resetting"
// page while the nightly reset refills the database (gate.js), and says so while the container starts. The app's built static files are served by Cloudflare
// without reaching the container (wrangler.jsonc, assets).
//
// The nightly reset does not run here: it runs from GitHub Actions as the database owner
// (.github/workflows/reset-aoa.yml), whose login the container never gets. At 07:00 UTC this Worker's cron asks
// GitHub to start it, because GitHub starts scheduled runs hours late (demo-edge/reset-dispatch.js).

import { DurableObject } from 'cloudflare:workers';
import { Container, getContainer } from '@cloudflare/containers';
import demoConfig from '../../demo-config.json';
import { dispatchReset } from '../../../demo-edge/reset-dispatch.js';
import { themeRedirect } from '../../../demo-edge/theme-handoff.js';
import {
  fetchWhenStarted,
  isStartingResponse,
  startContainerForDeploy,
  startedResponse,
  STARTED_PATH,
} from '../../../demo-edge/container-start.js';
import { retireStaleContainer } from './container-settings.js';
import { GATE_PATH, gateUntil, gateUntilOrOpen, readGateChange, resettingResponse, showsResettingPage } from './gate.js';
import {
  bodyWithinLimit,
  forwardableHeaders,
  PRIVATE_PATHS,
  routedPath,
  visitorKey,
  visitorPseudonym,
  withAnalyticsScript,
  WRITE_METHODS,
} from './rules.js';

// The app's server reads the theme from its own cookie (lib/theme.ts), so the hand-off sets that cookie.
const THEME = { cookie: 'theme' };

// The demo's name and the site's accent for it (site/src/styles/global.css), on the page shown while its container
// starts (demo-edge/container-start.js).
const DEMO = { name: 'Advisor platform', accent: ['#2E7D57', '#5CCB95'] };

// Used only if the deploy's VISITOR_HASH_KEY is missing: pseudonyms then change per isolate, never fall back to IPs.
// Made on first use, since Workers refuse random values at global scope (the upload fails with code 10021).
let isolateKey;
const fallbackHashKey = () => (isolateKey ??= crypto.randomUUID());

// The gate's state, read from its Durable Object at most every few seconds per isolate.
const GATE_CHECK_MS = 5_000;
let gate = { until: 0, checkedAt: -Infinity };

export class AoaApp extends Container {
  defaultPort = 3000;
  sleepAfter = '10m';
  // The readiness ping, over plain http inside Cloudflare: the app's public liveness endpoint.
  pingEndpoint = 'containerstarthealthcheck/api/health';

  constructor(ctx, env) {
    super(ctx, env);
    // What a deploy sets, and so what a running container must have been started with (container-settings.js).
    // The database logins' passwords are derived from the owner's, so they stay the same from deploy to deploy.
    this.deploySettings = {
      ...demoConfig,
      AUTH_URL: env.APP_ORIGIN,
      AUTH_SECRET: env.AUTH_SECRET,
      DATABASE_URL: env.DATABASE_URL,
      DIRECT_DATABASE_URL: env.DIRECT_DATABASE_URL,
      INGEST_DATABASE_URL: env.INGEST_DATABASE_URL,
      CRM_RECONCILER_DATABASE_URL: env.CRM_RECONCILER_DATABASE_URL,
      // The Worker's version, so each deploy starts a container of its own rather than keeping the previous deploy's,
      // which Cloudflare may still be replacing; the deploy waits for this one (demo-edge/container-start.js).
      DEMO_WORKER_VERSION: env.CF_VERSION_METADATA?.id ?? '',
    };
    this.envVars = this.deploySettings;
  }

  // Once per object, shared by the requests that arrive while it runs; a failure is retried by the next request.
  checkSettings() {
    this.settingsChecked ??= retireStaleContainer({
      container: this.container,
      storage: this.ctx.storage,
      settings: this.deploySettings,
      destroy: () => this.destroy(),
    }).catch((error) => {
      this.settingsChecked = undefined;
      throw error;
    });
    return this.settingsChecked;
  }

  async fetch(request) {
    await this.checkSettings();
    return super.fetch(request);
  }

  // The deploy check (demo-edge/container-start.js): this deploy's container, started and answering.
  async startForDeploy() {
    await this.checkSettings();
    return startContainerForDeploy(this);
  }
}

/** The "resetting" page's state: until when it is up (epoch ms, 0 when down). One instance, named "gate". */
export class ResetGate extends DurableObject {
  async until() {
    return (await this.ctx.storage.get('until')) ?? 0;
  }

  async setUntil(until) {
    await this.ctx.storage.put('until', until);
    return until;
  }
}

const gateObject = (env) => env.RESET_GATE.get(env.RESET_GATE.idFromName('gate'));

// A failed read counts as no page (gateUntilOrOpen) and is tried again after the same few seconds.
async function gateUntilNow(env, now) {
  if (now - gate.checkedAt > GATE_CHECK_MS) {
    gate = { until: await gateUntilOrOpen(() => gateObject(env).until()), checkedAt: now };
  }
  return gate.until;
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
    if (url.pathname === STARTED_PATH) return startedResponse(request, env, getContainer(env.AOA_APP));
    const handoff = themeRedirect(request, THEME);
    if (handoff) return handoff;
    const path = routedPath(url.pathname);
    if (path === null) return new Response('Bad request', { status: 400 });

    if (path === GATE_PATH) {
      const change = await readGateChange(request, env.RESET_GATE_TOKEN);
      if (!change.ok) return new Response(null, { status: change.status });
      const until = await gateObject(env).setUntil(gateUntil(change.minutes, Date.now()));
      gate = { until, checkedAt: Date.now() };
      return new Response(null, { status: 204 });
    }
    if (PRIVATE_PATHS.test(path)) return new Response('Not found', { status: 404 });
    if (!bodyWithinLimit(request)) return new Response('Request too large', { status: 413 });

    const visitor = visitorKey(request.headers.get('CF-Connecting-IP') ?? '');
    const limits = [env.VISITOR_LIMIT.limit({ key: visitor })];
    if (WRITE_METHODS.has(request.method)) limits.push(env.WRITE_LIMIT.limit({ key: visitor }));
    if ((await Promise.all(limits)).some((result) => !result.success)) {
      return new Response('Too many requests. Please wait a minute.', { status: 429, headers: { 'retry-after': '60' } });
    }

    const now = Date.now();
    if (showsResettingPage(await gateUntilNow(env, now), now, path)) return resettingResponse(demoConfig.NEXT_PUBLIC_PORTFOLIO_URL);

    // Overwrite, never append: a value the browser sent would let anyone pick their own rate-limit bucket.
    const headers = forwardableHeaders(request.headers);
    headers.set('X-Forwarded-For', await visitorPseudonym(visitor, env.VISITOR_HASH_KEY ?? fallbackHashKey()));
    headers.set('X-Forwarded-Proto', 'https');
    const response = await fetchWhenStarted(getContainer(env.AOA_APP), new Request(request, { headers }), DEMO);
    if (isStartingResponse(response)) return response;

    const out = new Response(response.body, response);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    const csp = out.headers.get('content-security-policy');
    if (csp) out.headers.set('content-security-policy', withAnalyticsScript(csp));
    return out;
  },

  // Nightly at 07:00 UTC, like the other demos: start the reset workflow now.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(dispatchReset(env, 'reset-aoa.yml'));
  },
};
