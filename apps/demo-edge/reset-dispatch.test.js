import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchReset } from './reset-dispatch.js';

const ENV = { RESET_DISPATCH_TOKEN: 'github_pat_test', RESET_REPOSITORY: 'owner/portfolio' };

describe('dispatchReset', () => {
  const logs = [];
  vi.spyOn(console, 'log').mockImplementation((line) => logs.push(line));
  afterEach(() => {
    logs.length = 0;
  });

  it('asks GitHub to run the workflow on main, with the token only in the request', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await dispatchReset(ENV, 'reset-demo.yml', fetchImpl)).toBe('dispatched');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/owner/portfolio/actions/workflows/reset-demo.yml/dispatches');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer github_pat_test');
    expect(JSON.parse(init.body)).toEqual({ ref: 'main' });
    expect(logs).toEqual([JSON.stringify({ event: 'reset_dispatch', workflow: 'reset-demo.yml', outcome: 'dispatched', status: 204 })]);
    expect(logs.join('')).not.toContain('github_pat_test');
  });

  it('only logs when no token is set, so the fallback schedule resets the demo', async () => {
    const fetchImpl = vi.fn();
    expect(await dispatchReset({ RESET_REPOSITORY: 'owner/portfolio' }, 'reset-demo.yml', fetchImpl)).toBe('no_token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a repository or workflow name that is not a plain name', async () => {
    const fetchImpl = vi.fn();
    expect(await dispatchReset({ ...ENV, RESET_REPOSITORY: 'owner/portfolio/../x' }, 'reset-demo.yml', fetchImpl)).toBe('misconfigured');
    expect(await dispatchReset(ENV, '../deploy-demo.yml', fetchImpl)).toBe('misconfigured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs GitHub's status, not its body, when it refuses", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
    expect(await dispatchReset(ENV, 'reset-helpdesk.yml', fetchImpl)).toBe('refused');
    expect(logs).toEqual([JSON.stringify({ event: 'reset_dispatch', workflow: 'reset-helpdesk.yml', outcome: 'refused', status: 401 })]);
  });

  it('survives GitHub being unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(await dispatchReset(ENV, 'reset-demo.yml', fetchImpl)).toBe('unreachable');
  });
});
