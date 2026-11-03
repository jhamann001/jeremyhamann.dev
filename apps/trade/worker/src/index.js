// The Trade Request demo at trade.jeremyhamann.dev: a Worker in front of the app's container.
// It sends http to https, turns away floods per visitor, passes each visitor's IP to the app (its rate
// limits key on it), keeps the app's scheduler and machine endpoints private, keeps search engines out,
// starts each visitor in the portfolio site's theme, says so while the container starts, and runs the
// nightly reset. The client's built files are served by Cloudflare without reaching the container
// (wrangler.jsonc, assets).

import { Container, getContainer } from '@cloudflare/containers';
import demoConfig from '../../demo-config.json';
import {
  fetchWhenStarted,
  isStartingResponse,
  startContainerForDeploy,
  startedResponse,
  STARTED_PATH,
} from '../../../demo-edge/container-start.js';
import { cookieTheme, themeRedirect, withTheme } from '../../../demo-edge/theme-handoff.js';
import { forwardableHeaders } from '../../../demo-edge/visitor-headers.js';
import { retireStaleContainer } from './container-settings.js';

// The client keeps its theme under this key and applies it only once its scripts run
// (client/src/contexts/ThemeContext.tsx), so the hand-off also paints the dark class straight away.
const THEME = { storageKey: 'theme-preference', darkClass: true };

// The demo's name and the site's accent for it (site/src/styles/global.css), on the page shown while its container
// starts (demo-edge/container-start.js).
const DEMO = { name: 'Trade Request', accent: ['#0D9488', '#2DD4BF'] };

// A key shared only by the app and its own stand-ins inside the container, fresh for each start.
const freshKey = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

export class TradeApp extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';

  constructor(ctx, env) {
    super(ctx, env);
    // What a deploy sets, and so what a running container must have been started with (container-settings.js).
    this.deploySettings = {
      ...demoConfig,
      CLIENT_ORIGIN: env.APP_ORIGIN,
      DATABASE_URL: env.DATABASE_URL,
      SESSION_SECRET: env.SESSION_SECRET,
      DEMO_RESET_TOKEN: env.DEMO_RESET_TOKEN,
      // The Worker's version, so each deploy starts a container of its own rather than keeping the previous deploy's,
      // which Cloudflare may still be replacing; the deploy waits for this one (demo-edge/container-start.js).
      DEMO_WORKER_VERSION: env.CF_VERSION_METADATA?.id ?? '',
    };
    // Only the container itself uses these, so a container that outlives this object keeps working with its own.
    this.envVars = { ...this.deploySettings, WAREHOUSE_API_KEY: freshKey(), SLACK_BOT_TOKEN: freshKey() };
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

// The app's own scheduler, machine and ops-portal endpoints have no outside caller in the demo.
const PRIVATE_PATHS = /^\/api\/(internal|machine|ops-portal)(\/|$)/i;

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
    if (url.pathname === STARTED_PATH) return startedResponse(request, env, getContainer(env.TRADE_APP));
    const handoff = themeRedirect(request);
    if (handoff) return handoff;
    if (PRIVATE_PATHS.test(url.pathname)) return new Response('Not found', { status: 404 });

    const visitor = request.headers.get('CF-Connecting-IP') ?? '';
    const { success } = await env.VISITOR_LIMIT.limit({ key: visitor });
    if (!success) {
      return new Response('Too many requests. Please wait a minute.', { status: 429, headers: { 'retry-after': '60' } });
    }

    // Overwrite, never append: the app trusts one proxy hop and reads the visitor from this header.
    // Without Cloudflare's own cf-* headers (the visitor's address among them) or a visitor's forwarding headers.
    const headers = forwardableHeaders(request.headers);
    headers.set('X-Forwarded-For', visitor);
    headers.set('X-Forwarded-Proto', 'https');
    const response = await fetchWhenStarted(getContainer(env.TRADE_APP), new Request(request, { headers }), DEMO);
    if (isStartingResponse(response)) return response;

    const out = new Response(response.body, response);
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    const theme = cookieTheme(request);
    return theme ? withTheme(out, theme, THEME) : out;
  },

  // Nightly at 07:00 UTC (about 3 AM Eastern): reseed the demo and rerun its jobs (demo/reset.ts).
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(resetDemo(env));
  },
};

async function resetDemo(env) {
  const request = new Request(`${env.APP_ORIGIN}/api/internal/demo-reset`, {
    method: 'POST',
    headers: { 'x-demo-reset-token': env.DEMO_RESET_TOKEN, 'x-forwarded-proto': 'https' },
  });
  const response = await getContainer(env.TRADE_APP).fetch(request);
  const body = await response.text();
  if (!response.ok) throw new Error(`demo reset failed: ${response.status} ${body.slice(0, 300)}`);
  console.log(`demo reset complete: ${body.slice(0, 500)}`);
}
