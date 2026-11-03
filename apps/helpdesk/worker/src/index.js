// The WM Help Desk demo at helpdesk.jeremyhamann.dev: a Worker in front of the app's container. It sends http
// to https, turns away floods per visitor and oversized requests, passes each visitor's address to the app (its
// rate limits key on it), keeps the app's machine endpoints private, keeps search engines out, starts each
// visitor in the portfolio site's theme, and says so while the container starts. The app's built static files are served by Cloudflare without reaching
// the container (wrangler.jsonc, assets).
//
// The daily reset does not run here. The ledger's tables refuse UPDATE and DELETE even to the app, so the reset
// runs as the database owner from GitHub Actions (.github/workflows/reset-helpdesk.yml). At 14:00 UTC this
// Worker's cron asks GitHub to start it, because GitHub starts scheduled runs hours late (demo-edge/reset-dispatch.js).

import { Container, getContainer } from '@cloudflare/containers';
import demoConfig from '../../demo-config.json';
import { dispatchReset } from '../../../demo-edge/reset-dispatch.js';
import { cookieTheme, themeRedirect, withTheme } from '../../../demo-edge/theme-handoff.js';
import {
  fetchWhenStarted,
  isStartingResponse,
  startContainerForDeploy,
  startedResponse,
  STARTED_PATH,
} from '../../../demo-edge/container-start.js';
import { retireStaleContainer } from './container-settings.js';
import { bodyWithinLimit, forwardableHeaders, PRIVATE_PATHS, routedPath, visitorKey, visitorPseudonym } from './rules.js';

// next-themes keeps the theme under its default key (src/components/providers.tsx).
const THEME = { storageKey: 'theme' };

// The demo's name and the site's accent for it (site/src/styles/global.css), on the page shown while its container
// starts (demo-edge/container-start.js).
const DEMO = { name: 'WM Help Desk', accent: ['#4F5FE8', '#8B96FF'] };

// Used only if the deploy's VISITOR_HASH_KEY is missing: pseudonyms then change per isolate, never fall back to IPs.
// Made on first use, since Workers refuse random values at global scope (the upload fails with code 10021).
let isolateKey;
const fallbackHashKey = () => (isolateKey ??= crypto.randomUUID());

// A key shared only by the app and its own stand-ins inside the container, fresh for each start.
const freshKey = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

export class HelpdeskApp extends Container {
  defaultPort = 3000;
  sleepAfter = '10m';
  // The readiness ping, over plain http inside Cloudflare: the app's public liveness endpoint.
  pingEndpoint = 'containerstarthealthcheck/api/health';

  constructor(ctx, env) {
    super(ctx, env);
    // What a deploy sets, and so what a running container must have been started with (container-settings.js).
    this.deploySettings = {
      ...demoConfig,
      DATABASE_URL: env.DATABASE_URL,
      AUTH_SECRET: env.AUTH_SECRET,
      // Stable for a deploy, so a reply-to address in the Outbox still routes after the container sleeps.
      REPLY_TOKEN_SECRET: env.REPLY_TOKEN_SECRET,
      // The Worker's version, so each deploy starts a container of its own rather than keeping the previous deploy's,
      // which Cloudflare may still be replacing; the deploy waits for this one (demo-edge/container-start.js).
      DEMO_WORKER_VERSION: env.CF_VERSION_METADATA?.id ?? '',
    };
    // As at Slack, a webhook's path is its credential (src/lib/demo/stand-ins/slack.ts).
    const slack = (channel) => `http://127.0.0.1:${demoConfig.STAND_INS_PORT}/slack/${channel}/${freshKey()}`;
    this.envVars = {
      ...this.deploySettings,
      // The keys the stand-in mail sender and the Outbox's buttons use over loopback. Only the container itself
      // uses them, so a container that outlives this object keeps working with its own.
      OUTBOX_API_TOKEN: freshKey(),
      INGEST_API_TOKEN: freshKey(),
      SLA_ALERT_SLACK_WEBHOOK_URL: slack('sla-alerts'),
      SLACK_QUEUE_WEBHOOKS: JSON.stringify({
        OPERATIONS: slack('ops-desk'),
        CLIENT_SERVICE: slack('client-service'),
        ADVICE: slack('advice-desk'),
      }),
    };
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
    if (url.pathname === STARTED_PATH) return startedResponse(request, env, getContainer(env.HELPDESK_APP));
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

    // Overwrite, never append: the app keys its rate limits on this header, and a value the browser sent
    // would let anyone pick their own bucket. A pseudonym, never the address: the audit log shows it.
    const headers = forwardableHeaders(request.headers);
    headers.set('X-Forwarded-For', await visitorPseudonym(visitor, env.VISITOR_HASH_KEY ?? fallbackHashKey()));
    headers.set('X-Forwarded-Proto', 'https');
    const response = await fetchWhenStarted(getContainer(env.HELPDESK_APP), new Request(request, { headers }), DEMO);
    if (isStartingResponse(response)) return response;

    const out = new Response(response.body, response);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    const theme = cookieTheme(request);
    return theme ? withTheme(out, theme, THEME) : out;
  },

  // Daily at 14:00 UTC, the time the sign-in page gives: start the reset workflow now.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(dispatchReset(env, 'reset-helpdesk.yml'));
  },
};
