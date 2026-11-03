import { describe, expect, it, vi } from 'vitest';
import { waitForDeploy } from './wait-for-deploy.mjs';

const SITE = 'https://trade.example';

// Answers by address: the deploy check's in order, then the sign-in page's; the last of each repeats.
function fakeSite({ started, signIn = [200] }) {
  const queues = { started: [...started], signIn: [...signIn] };
  const next = (queue) => (queue.length > 1 ? queue.shift() : queue[0]);
  return vi.fn(async (url) => {
    const answer = url.includes('/__demo/started') ? next(queues.started) : next(queues.signIn);
    if (answer instanceof Error) throw answer;
    if (answer === 'ready') return Response.json({ ready: true, startedMs: 20_000 });
    return new Response(null, { status: answer });
  });
}

function run(fetch, extra = {}) {
  let t = 0;
  const log = vi.fn();
  const wait = vi.fn(async (ms) => (t += ms));
  const done = waitForDeploy({ site: SITE, version: 'v-new', signInPath: '/', fetch, wait, now: () => t, log, ...extra });
  return { done, log, wait };
}

describe('waiting for a demo’s deploy', () => {
  it('asks the deploy check with this deploy’s version, then the sign-in page three times', async () => {
    const fetch = fakeSite({ started: ['ready'] });
    const { done, log } = run(fetch);
    expect(await done).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(`${SITE}/__demo/started?version=v-new`);
    expect(fetch.mock.calls.slice(1).map(([url]) => url)).toEqual(Array(3).fill(`${SITE}/`));
    expect(log.mock.calls.at(-1)[0]).toMatch(/^Live: /);
  });

  it('keeps asking while an older Worker version answers or the container can’t start', async () => {
    const fetch = fakeSite({ started: [404, 503, new DOMException('timed out', 'TimeoutError'), 'ready'] });
    const { done, log } = run(fetch);
    expect(await done).toBe(true);
    expect(log.mock.calls.map(([line]) => line).join('\n')).toMatch(/404: an older Worker version answered[\s\S]*503[\s\S]*TimeoutError/);
  });

  it('starts the count of good answers again after one bad one', async () => {
    const fetch = fakeSite({ started: ['ready'], signIn: [200, 503, 200, 200, 200] });
    const { done } = run(fetch);
    expect(await done).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('gives up when the container never comes', async () => {
    const { done, log } = run(fakeSite({ started: [503] }), { limitMs: 60_000 });
    expect(await done).toBe(false);
    expect(log.mock.calls.at(-1)[0]).toMatch(/never answered \(last: 503\)/);
  });

  it('gives up when the sign-in page won’t stay up', async () => {
    const { done, log } = run(fakeSite({ started: ['ready'], signIn: [200, 500] }), { limitMs: 60_000 });
    expect(await done).toBe(false);
    expect(log.mock.calls.at(-1)[0]).toMatch(/didn't stay up/);
  });
});
