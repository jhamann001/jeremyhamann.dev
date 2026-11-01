import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { AuthUser } from '@trade-request/shared';
import { SessionBanner } from '../SessionBanner';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  fetchAppConfig: vi.fn(),
  extendSession: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mocks.useAuth(),
}));

vi.mock('../../api/client', () => ({
  fetchAppConfig: () => mocks.fetchAppConfig(),
  extendSession: () => mocks.extendSession(),
}));

const mockUser: AuthUser = {
  id: '1',
  name: 'Session User',
  email: 's@test.com',
  googleId: 'g',
  picture: null,
  role: 'advisor',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function simulateVisibilityChange(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, writable: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('SessionBanner', () => {
  beforeEach(() => {
    mocks.useAuth.mockReturnValue({
      user: mockUser,
      actualUser: mockUser,
      loading: false,
      error: null,
      logout: async () => {},
      refresh: async () => {},
      roleOverride: null,
      setRoleOverride: () => {},
    });
    mocks.extendSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns null when session has plenty of time', async () => {
    mocks.fetchAppConfig.mockResolvedValue({ allowedDomains: ['test.com'], sessionTtlMs: 60 * 60 * 1000 });

    const { container } = render(<SessionBanner />);

    await waitFor(() => expect(mocks.fetchAppConfig).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('shows banner when remaining time is below threshold', async () => {
    const frozenMs = new Date('2026-03-30T12:00:00.000Z').getTime();
    const timeSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenMs);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    mocks.fetchAppConfig.mockResolvedValue({
      allowedDomains: ['test.com'],
      sessionTtlMs: 4 * 60 * 1000,
    });

    render(<SessionBanner />);

    await waitFor(() => expect(mocks.fetchAppConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(() => {
      vi.advanceTimersByTime(10_000);
    });

    const banner = screen.getByRole('status');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/your session expires in/i);

    timeSpy.mockRestore();
  }, 15_000);

  it("shows 'Extend Session' button", async () => {
    const frozenMs = new Date('2026-03-30T12:00:00.000Z').getTime();
    const timeSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenMs);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    mocks.fetchAppConfig.mockResolvedValue({
      allowedDomains: ['test.com'],
      sessionTtlMs: 4 * 60 * 1000,
    });

    render(<SessionBanner />);

    await waitFor(() => expect(mocks.fetchAppConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByRole('button', { name: 'Extend Session' })).toBeInTheDocument();

    timeSpy.mockRestore();
  }, 15_000);

  it('recovers session on tab focus when expired and server session is still alive', async () => {
    const frozenMs = new Date('2026-03-30T12:00:00.000Z').getTime();
    const timeSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenMs);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const logoutFn = vi.fn<() => Promise<void>>();
    mocks.useAuth.mockReturnValue({
      user: mockUser,
      actualUser: mockUser,
      loading: false,
      error: null,
      logout: logoutFn,
      refresh: async () => {},
      roleOverride: null,
      setRoleOverride: () => {},
    });

    mocks.fetchAppConfig.mockResolvedValue({ allowedDomains: ['test.com'], sessionTtlMs: 10 * 60 * 1000 });
    mocks.extendSession.mockResolvedValue(undefined);

    render(<SessionBanner />);
    await waitFor(() => expect(mocks.fetchAppConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    timeSpy.mockReturnValue(frozenMs + 11 * 60 * 1000);

    await act(async () => {
      simulateVisibilityChange('visible');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.extendSession).toHaveBeenCalled();
    expect(logoutFn).not.toHaveBeenCalled();

    timeSpy.mockRestore();
  }, 15_000);

  it('logs out on tab focus when expired and server session is also expired', async () => {
    const frozenMs = new Date('2026-03-30T12:00:00.000Z').getTime();
    const timeSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenMs);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const logoutFn = vi.fn<() => Promise<void>>();
    mocks.useAuth.mockReturnValue({
      user: mockUser,
      actualUser: mockUser,
      loading: false,
      error: null,
      logout: logoutFn,
      refresh: async () => {},
      roleOverride: null,
      setRoleOverride: () => {},
    });

    mocks.fetchAppConfig.mockResolvedValue({ allowedDomains: ['test.com'], sessionTtlMs: 10 * 60 * 1000 });
    mocks.extendSession.mockRejectedValue(new Error('401'));

    render(<SessionBanner />);
    await waitFor(() => expect(mocks.fetchAppConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    timeSpy.mockReturnValue(frozenMs + 11 * 60 * 1000);

    await act(async () => {
      simulateVisibilityChange('visible');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.extendSession).toHaveBeenCalled();
    expect(logoutFn).toHaveBeenCalled();

    timeSpy.mockRestore();
  }, 15_000);

  it('does not logout during recovery while interval fires', async () => {
    const frozenMs = new Date('2026-03-30T12:00:00.000Z').getTime();
    const timeSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenMs);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const logoutFn = vi.fn<() => Promise<void>>();
    mocks.useAuth.mockReturnValue({
      user: mockUser,
      actualUser: mockUser,
      loading: false,
      error: null,
      logout: logoutFn,
      refresh: async () => {},
      roleOverride: null,
      setRoleOverride: () => {},
    });

    mocks.fetchAppConfig.mockResolvedValue({ allowedDomains: ['test.com'], sessionTtlMs: 10 * 60 * 1000 });

    let resolveExtend!: () => void;
    mocks.extendSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveExtend = resolve;
        }),
    );

    render(<SessionBanner />);
    await waitFor(() => expect(mocks.fetchAppConfig).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    timeSpy.mockReturnValue(frozenMs + 11 * 60 * 1000);

    await act(async () => {
      simulateVisibilityChange('visible');
      await Promise.resolve();
    });

    await act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(logoutFn).not.toHaveBeenCalled();

    await act(async () => {
      resolveExtend();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(logoutFn).not.toHaveBeenCalled();

    timeSpy.mockRestore();
  }, 15_000);
});
