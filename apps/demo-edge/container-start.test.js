import { describe, expect, it, vi } from 'vitest';
import {
  fetchWhenStarted,
  isStartFailure,
  isStartingResponse,
  RETRY_FOR_MS,
  startContainerForDeploy,
  startedResponse,
  STARTED_PATH,
} from './container-start.js';

const DEMO = { name: 'Trade Request', accent: ['#0D9488', '#2DD4BF'] };
const page = (path = '/', init = {}) => new Request(`https://trade.example${path}`, { headers: { accept: 'text/html' }, ...init });

// The library's own answers when no container can be reached (@cloudflare/containers, containerFetch).
const noInstance = () => new Response('There is no Container instance available at this time.\nThis is likely because…', { status: 503 });
const notStarted = () => new Response('Failed to start container: Durable Object reset because its code was updated.', { status: 500 });

// A clock that moves only when the Worker waits, so the retry window is measured in pauses.
function fakeTime() {
  let t = 0;
  return { now: () => t, wait: vi.fn(async (ms) => (t += ms)), advance: (ms) => (t += ms) };
}

function container(...answers) {
  const fetch = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    return next();
  });
  return { fetch };
}

describe('telling the library’s "no container" answers from the app’s own', () => {
  it('knows the library’s texts by status and opening words', async () => {
    expect(await isStartFailure(noInstance())).toBe(true);
    expect(await isStartFailure(notStarted())).toBe(true);
    expect(await isStartFailure(new Response('Container suddenly disconnected, try again', { status: 500 }))).toBe(true);
  });

  it('passes on what the app itself says, even with the same status', async () => {
    expect(await isStartFailure(Response.json({ status: 'unhealthy' }, { status: 503 }))).toBe(false);
    expect(await isStartFailure(new Response('Internal Server Error', { status: 500 }))).toBe(false);
    expect(await isStartFailure(new Response('There is no Container instance available', { status: 502 }))).toBe(false);
    expect(await isStartFailure(new Response('ok'))).toBe(false);
  });

  it('leaves the response readable after looking', async () => {
    const response = new Response('Internal Server Error', { status: 500 });
    await isStartFailure(response);
    expect(await response.text()).toBe('Internal Server Error');
  });
});

describe('a request while the container starts', () => {
  it('passes the container’s answer through when it has one', async () => {
    const ok = new Response('<h1>Sign in</h1>');
    const result = await fetchWhenStarted({ fetch: async () => ok }, page(), DEMO);
    expect(result).toBe(ok);
    expect(isStartingResponse(result)).toBe(false);
  });

  it('asks again for a page load, and returns the page once the container answers', async () => {
    const time = fakeTime();
    const app = container(noInstance, noInstance, () => new Response('<h1>Sign in</h1>'));
    const result = await fetchWhenStarted(app, page(), DEMO, time);
    expect(await result.text()).toBe('<h1>Sign in</h1>');
    expect(app.fetch).toHaveBeenCalledTimes(3);
    expect(time.wait).toHaveBeenCalledTimes(2);
  });

  it('asks again after the object itself fails mid-start', async () => {
    const time = fakeTime();
    const app = container(new Error('Network connection lost.'), () => new Response('ok'));
    expect(await (await fetchWhenStarted(app, page(), DEMO, time)).text()).toBe('ok');
  });

  it('serves the starting page once the window runs out', async () => {
    const time = fakeTime();
    const app = container(noInstance);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await fetchWhenStarted(app, page('/dashboard?tab=open'), DEMO, time);
    expect(isStartingResponse(result)).toBe(true);
    expect(result.status).toBe(503);
    expect(result.headers.get('retry-after')).toBe('5');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(result.headers.get('content-security-policy')).toMatch(/^default-src 'none'; style-src 'unsafe-inline'/);
    expect(time.now()).toBeGreaterThanOrEqual(RETRY_FOR_MS);
    const html = await result.text();
    expect(html).toContain('<h1>The demo is starting up</h1>');
    expect(html).toContain('Trade Request');
    expect(html).toContain('<meta http-equiv="refresh" content="5;url=/dashboard?tab=open">');
    expect(html).toContain('<a class="btn" href="/dashboard?tab=open">Try now</a>');
    expect(html).not.toContain('<script');
  });

  it('never sends a write twice, and answers it with a short JSON 503', async () => {
    const app = container(noInstance);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await fetchWhenStarted(app, new Request('https://trade.example/api/requests', { method: 'POST', body: '{}' }), DEMO, fakeTime());
    expect(app.fetch).toHaveBeenCalledOnce();
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'starting', message: 'The demo is starting up. Try again in a few seconds.' });
  });

  it('sends a form post’s visitor back to the front page, not to the address they posted to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const form = page('/auth/persona', { method: 'POST', body: 'persona=a' });
    const html = await (await fetchWhenStarted(container(noInstance), form, DEMO, fakeTime())).text();
    expect(html).toContain('content="5;url=/"');
  });

  it('gives an app’s own API call JSON, not the page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = new Request('https://trade.example/auth/me', { headers: { accept: 'application/json' } });
    const result = await fetchWhenStarted(container(noInstance), api, DEMO, fakeTime());
    expect(result.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('keeps the reload on the demo, whatever the address', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = await (await fetchWhenStarted(container(noInstance), page('//evil.example/x"<b>'), DEMO, fakeTime())).text();
    expect(html).toContain('content="5;url=/evil.example/x%22%3Cb%3E"');
    expect(html).not.toMatch(/url=\/\//);
  });

  it('paints the theme the visitor arrived with, and otherwise follows their system', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dark = page('/', { headers: { accept: 'text/html', cookie: 'demo_theme=dark' } });
    expect(await (await fetchWhenStarted(container(noInstance), dark, DEMO, fakeTime())).text()).toContain('<html lang="en" data-theme="dark">');
    expect(await (await fetchWhenStarted(container(noInstance), page(), DEMO, fakeTime())).text()).toContain('<html lang="en">\n');
  });
});

describe('the deploy check', () => {
  const env = { CF_VERSION_METADATA: { id: 'version-new' } };
  const check = (version, method = 'GET') => new Request(`https://trade.example${STARTED_PATH}?version=${version}`, { method });

  it('isn’t there without this Worker’s own version', async () => {
    const app = { startForDeploy: vi.fn() };
    for (const request of [check('version-old'), check(''), new Request(`https://trade.example${STARTED_PATH}`), check('version-new', 'POST')]) {
      expect((await startedResponse(request, env, app)).status).toBe(404);
    }
    expect((await startedResponse(check('version-new'), {}, app)).status).toBe(404);
    expect(app.startForDeploy).not.toHaveBeenCalled();
  });

  it('starts the container and answers once it is up', async () => {
    const app = { startForDeploy: vi.fn(async () => ({ startedMs: 21_000 })) };
    const response = await startedResponse(check('version-new'), env, app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true, startedMs: 21_000 });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 while the container can’t be started yet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = { startForDeploy: vi.fn(async () => Promise.reject(new Error('there is no container instance that can be provided to this durable object'))) };
    const response = await startedResponse(check('version-new'), env, app);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false });
  });

  it('waits far longer for the container than a visitor’s request does', async () => {
    const app = { startAndWaitForPorts: vi.fn(async () => {}) };
    let t = 0;
    const now = () => (t += 4_000);
    expect(await startContainerForDeploy(app, { now })).toEqual({ startedMs: 4_000 });
    const [{ cancellationOptions }] = app.startAndWaitForPorts.mock.calls[0];
    expect(cancellationOptions.instanceGetTimeoutMS).toBeGreaterThanOrEqual(60_000);
    expect(cancellationOptions.portReadyTimeoutMS).toBeGreaterThan(cancellationOptions.instanceGetTimeoutMS);
  });
});
