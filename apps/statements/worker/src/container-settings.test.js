import { describe, expect, it, vi } from 'vitest';
import { retireStaleContainer, settingsFingerprint, STARTED_WITH_KEY } from './container-settings.js';

// The same checks as the help desk Worker's copy of this module; the Durable Object that uses it is tested in
// index.test.js.

const deploy = (token) => ({ DATABASE_URL: 'postgres://app:pw@db.example/statements', DEMO_RESET_TOKEN: token });

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

  it('retires a container started with the previous deploy’s reset token', async () => {
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
