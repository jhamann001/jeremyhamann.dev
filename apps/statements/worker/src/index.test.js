import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsFingerprint, STARTED_WITH_KEY } from './container-settings.js';
import { CONTENT_SECURITY_POLICY, visitorPseudonym } from './rules.js';

// The runtime's container and the library's Durable Object, reduced to what the Worker touches.
const { containerFetch } = vi.hoisted(() => ({ containerFetch: vi.fn() }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
      this.container = ctx.container;
    }
    destroy() {
      return this.container.destroy();
    }
    async fetch() {
      return new Response('from the container');
    }
  },
  getContainer: vi.fn(() => ({ fetch: containerFetch })),
}));

const { default: worker, resetDemo, StatementsApp } = await import('./index.js');

const ORIGIN = 'https://statements.example';
const env = (overrides = {}) => ({
  APP_ORIGIN: ORIGIN,
  DATABASE_URL: 'postgres://app:pw@db.example/statements',
  SESSION_SECRET: 's'.repeat(64),
  DEMO_RESET_TOKEN: 'reset-token',
  VISITOR_HASH_KEY: 'visitor-key',
  CF_VERSION_METADATA: { id: 'version-one' },
  STATEMENTS_APP: {},
  VISITOR_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
  ...overrides,
});

const page = () =>
  new Response('<!DOCTYPE html><html><head><script src="/theme.js"></script></head><body></body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

beforeEach(() => {
  containerFetch.mockReset();
  containerFetch.mockImplementation(async () => page());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeRuntime({ running, startedWith }) {
  const values = new Map(startedWith === undefined ? [] : [[STARTED_WITH_KEY, startedWith]]);
  const container = {
    running,
    destroy: vi.fn(async () => {
      container.running = false;
    }),
  };
  const storage = { get: vi.fn(async (key) => values.get(key)), put: vi.fn(async (key, value) => values.set(key, value)) };
  return { container, storage, values, destroy: container.destroy };
}

describe('the Statement Analyzer’s Durable Object', () => {
  it('starts the container in demo mode with the deploy’s secrets, and fingerprints exactly those', async () => {
    const runtime = fakeRuntime({ running: false });
    const object = new StatementsApp({ container: runtime.container, storage: runtime.storage }, env());
    expect(object.envVars).toEqual({
      DEMO_MODE: 'on',
      DATABASE_URL: 'postgres://app:pw@db.example/statements',
      SESSION_SECRET: 's'.repeat(64),
      DEMO_RESET_TOKEN: 'reset-token',
      DEMO_WORKER_VERSION: 'version-one',
    });
    expect(object.defaultPort).toBe(8080);
    await object.fetch(new Request(`${ORIGIN}/`));
    expect(runtime.values.get(STARTED_WITH_KEY)).toBe(await settingsFingerprint(object.envVars));
  });

  it('retires a container started by the previous deploy once, however many requests arrive together', async () => {
    const runtime = fakeRuntime({ running: true, startedWith: 'the previous deploy' });
    const object = new StatementsApp({ container: runtime.container, storage: runtime.storage }, env());
    const responses = await Promise.all([1, 2, 3].map(() => object.fetch(new Request(`${ORIGIN}/`))));
    expect(await Promise.all(responses.map((r) => r.text()))).toEqual(Array(3).fill('from the container'));
    expect(runtime.destroy).toHaveBeenCalledOnce();
    expect(runtime.storage.get).toHaveBeenCalledOnce();
  });
});

describe('the Statement Analyzer Worker’s requests', () => {
  it('sends http to https and keeps search engines out', async () => {
    const http = await worker.fetch(new Request('http://statements.example/households?x=1'), env());
    expect(http.status).toBe(301);
    expect(http.headers.get('location')).toBe(`${ORIGIN}/households?x=1`);
    const robots = await worker.fetch(new Request(`${ORIGIN}/robots.txt`), env());
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('answers the private routes, oversized bodies and floods itself, without waking the container', async () => {
    const e = env();
    expect((await worker.fetch(new Request(`${ORIGIN}/api/internal/demo-reset`, { method: 'POST' }), e)).status).toBe(404);
    expect((await worker.fetch(new Request(`${ORIGIN}/docs`), e)).status).toBe(404);
    expect((await worker.fetch(new Request(`${ORIGIN}/%E0%A4%A`), e)).status).toBe(400);
    const big = new Request(`${ORIGIN}/api/samples/run`, {
      method: 'POST',
      headers: { 'content-length': String(200 * 1024) },
      body: 'x',
    });
    expect((await worker.fetch(big, e)).status).toBe(413);
    expect(e.VISITOR_LIMIT.limit).not.toHaveBeenCalled();

    const flooded = env({ VISITOR_LIMIT: { limit: vi.fn(async () => ({ success: false })) } });
    const refused = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { 'cf-connecting-ip': '203.0.113.7' } }), flooded);
    expect(refused.status).toBe(429);
    expect(flooded.VISITOR_LIMIT.limit).toHaveBeenCalledWith({ key: '203.0.113.7' });
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('tells the app the visitor’s pseudonym, overwriting whatever the browser sent', async () => {
    const request = new Request(`${ORIGIN}/api/samples/run`, {
      method: 'POST',
      headers: {
        'cf-connecting-ip': '2001:db8:1:2:3:4:5:6',
        'x-forwarded-for': '198.51.100.9',
        'x-real-ip': '198.51.100.9',
        'cf-container-target-port': '9000',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': '24',
      },
      body: '{"samples":["okafor"]}  ',
    });
    await worker.fetch(request, env());
    const [forwarded] = containerFetch.mock.calls[0];
    expect(forwarded.method).toBe('POST');
    expect(new URL(forwarded.url).pathname).toBe('/api/samples/run');
    expect(forwarded.headers.get('x-forwarded-for')).toBe(await visitorPseudonym('2001:db8:1:2::/64', 'visitor-key'));
    expect(forwarded.headers.get('x-forwarded-proto')).toBe('https');
    expect(forwarded.headers.get('x-real-ip')).toBeNull();
    expect(forwarded.headers.get('cf-connecting-ip')).toBeNull();
    expect(forwarded.headers.get('cf-container-target-port')).toBeNull();
    expect(forwarded.headers.get('sec-fetch-site')).toBe('same-origin');
    expect(await forwarded.text()).toBe('{"samples":["okafor"]}  ');
  });

  it('puts the page under the policy and out of search engines', async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/`), env());
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('hands the theme over with its line’s hash added to the policy', async () => {
    // Enough of the runtime's HTMLRewriter for a prepend to <head>.
    vi.stubGlobal(
      'HTMLRewriter',
      class {
        on(_selector, handlers) {
          this.handlers = handlers;
          return this;
        }
        transform(response) {
          const { handlers } = this;
          const body = new ReadableStream({
            async start(controller) {
              let html = await response.text();
              handlers.element({ prepend: (tag) => (html = html.replace('<head>', `<head>${tag}`)) });
              controller.enqueue(new TextEncoder().encode(html));
              controller.close();
            },
          });
          return new Response(body, response);
        }
      },
    );
    const handoff = await worker.fetch(new Request(`${ORIGIN}/?theme=dark`), env());
    expect(handoff.status).toBe(302);
    expect(handoff.headers.get('location')).toBe(`${ORIGIN}/`);

    const cookie = handoff.headers.get('set-cookie').split(';')[0];
    const response = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { cookie } }), env());
    const html = await response.text();
    expect(html).toMatch(/^<!DOCTYPE html><html><head><script>try\{localStorage\.setItem\("theme","dark"\)\}catch\(e\)\{\}<\/script>/);
    const scriptSrc = response.headers.get('content-security-policy').split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toMatch(/^script-src 'self' https:\/\/static\.cloudflareinsights\.com 'sha256-[A-Za-z0-9+/]+=*'$/);
    expect(response.headers.get('set-cookie')).toContain('demo_theme=; Path=/; Max-Age=0');
  });
});

describe('the nightly reset', () => {
  it('asks the app to reset with the deploy’s token', async () => {
    containerFetch.mockImplementation(async () => new Response('{"runs":48}'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await resetDemo(env());
    const [request] = containerFetch.mock.calls[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${ORIGIN}/api/internal/demo-reset`);
    expect(request.headers.get('authorization')).toBe('Bearer reset-token');
  });

  it('tries once more after a failure, and reports a second failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const wait = vi.fn(async () => {});
    containerFetch
      .mockResolvedValueOnce(new Response('waking', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"runs":48}'));
    await resetDemo(env(), wait);
    expect(wait).toHaveBeenCalledWith(60_000);
    expect(containerFetch).toHaveBeenCalledTimes(2);

    containerFetch.mockReset();
    containerFetch.mockImplementation(async () => new Response('A run is still in progress', { status: 409 }));
    await expect(resetDemo(env(), wait)).rejects.toThrow('409 A run is still in progress');
  });
});
