import { describe, expect, it, vi } from 'vitest';
import { retireStaleContainer, settingsFingerprint, STARTED_WITH_KEY } from './container-settings.js';

// The runtime's container and the library's Durable Object, reduced to what the restart check touches.
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
  getContainer: vi.fn(),
}));

const deploy = (password) => ({ DATABASE_URL: `postgres://app:${password}@db.example/helpdesk`, AUTH_SECRET: 'a' });

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

describe('the container restart check', () => {
  it('fingerprints the settings without writing them down', async () => {
    const first = await settingsFingerprint(deploy('one'));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await settingsFingerprint(deploy('one'))).toBe(first);
    expect(await settingsFingerprint(deploy('two'))).not.toBe(first);
    expect(first).not.toContain('one');
  });

  it('leaves alone a container started with this deploy’s settings', async () => {
    const runtime = fakeRuntime({ running: true, startedWith: await settingsFingerprint(deploy('one')) });
    expect(await retireStaleContainer({ ...runtime, settings: deploy('one') })).toBe(false);
    expect(runtime.destroy).not.toHaveBeenCalled();
  });

  it('retires a container started with the previous deploy’s password', async () => {
    const runtime = fakeRuntime({ running: true, startedWith: await settingsFingerprint(deploy('one')) });
    expect(await retireStaleContainer({ ...runtime, settings: deploy('two') })).toBe(true);
    expect(runtime.destroy).toHaveBeenCalledOnce();
    expect(runtime.values.get(STARTED_WITH_KEY)).toBe(await settingsFingerprint(deploy('two')));
  });

  it('retires a running container whose settings were never recorded', async () => {
    const runtime = fakeRuntime({ running: true });
    expect(await retireStaleContainer({ ...runtime, settings: deploy('one') })).toBe(true);
    expect(runtime.destroy).toHaveBeenCalledOnce();
  });

  it('records the settings when no container runs, so the next start counts as current', async () => {
    const runtime = fakeRuntime({ running: false, startedWith: await settingsFingerprint(deploy('one')) });
    expect(await retireStaleContainer({ ...runtime, settings: deploy('two') })).toBe(false);
    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(runtime.values.get(STARTED_WITH_KEY)).toBe(await settingsFingerprint(deploy('two')));
  });

  it('records nothing when the stale container will not stop', async () => {
    const runtime = fakeRuntime({ running: true, startedWith: 'older' });
    runtime.container.destroy = vi.fn(async () => {
      throw new Error('no answer');
    });
    await expect(retireStaleContainer({ ...runtime, destroy: runtime.container.destroy, settings: deploy('one') })).rejects.toThrow();
    expect(runtime.values.get(STARTED_WITH_KEY)).toBe('older');
  });
});

describe('the help desk’s Durable Object', () => {
  const app = async (runtime, password) => {
    const { HelpdeskApp } = await import('./index.js');
    const env = { DATABASE_URL: deploy(password).DATABASE_URL, AUTH_SECRET: 'a', REPLY_TOKEN_SECRET: 'r' };
    return new HelpdeskApp({ container: runtime.container, storage: runtime.storage }, env);
  };

  it('checks once before its first request, however many arrive together', async () => {
    const runtime = fakeRuntime({ running: true, startedWith: 'the previous deploy' });
    const object = await app(runtime, 'two');
    const responses = await Promise.all([1, 2, 3].map(() => object.fetch(new Request('https://helpdesk.example/'))));
    expect(await Promise.all(responses.map((r) => r.text()))).toEqual(Array(3).fill('from the container'));
    expect(runtime.destroy).toHaveBeenCalledOnce();
    expect(runtime.storage.get).toHaveBeenCalledOnce();
    await object.fetch(new Request('https://helpdesk.example/'));
    expect(runtime.storage.get).toHaveBeenCalledOnce();
  });

  it('starts the container with the settings it fingerprints, and none of the per-start keys', async () => {
    const runtime = fakeRuntime({ running: false });
    const object = await app(runtime, 'two');
    await object.fetch(new Request('https://helpdesk.example/'));
    expect(runtime.values.get(STARTED_WITH_KEY)).toBe(await settingsFingerprint(object.deploySettings));
    expect(object.envVars).toMatchObject(object.deploySettings);
    expect(object.deploySettings).not.toHaveProperty('OUTBOX_API_TOKEN');
  });

  it('tries the check again on the next request after a failure', async () => {
    const runtime = fakeRuntime({ running: true, startedWith: 'the previous deploy' });
    runtime.container.destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error('no answer'))
      .mockImplementation(async () => {
        runtime.container.running = false;
      });
    const object = await app(runtime, 'two');
    await expect(object.fetch(new Request('https://helpdesk.example/'))).rejects.toThrow('no answer');
    expect(await (await object.fetch(new Request('https://helpdesk.example/'))).text()).toBe('from the container');
    expect(runtime.container.destroy).toHaveBeenCalledTimes(2);
  });
});
