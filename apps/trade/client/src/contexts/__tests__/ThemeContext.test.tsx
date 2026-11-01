import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '../ThemeContext';

vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    user: null,
    actualUser: null,
    loading: false,
    error: null,
    logout: async () => {},
    refresh: async () => {},
    roleOverride: null,
    setRoleOverride: () => {},
  }),
}));

const api = vi.hoisted(() => ({
  updateThemePreference: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  updateThemePreference: (pref: 'light' | 'dark' | 'system') => api.updateThemePreference(pref),
}));

function TestConsumer() {
  const { preference, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <button type="button" data-testid="set-dark" onClick={() => setPreference('dark')}>
        Dark
      </button>
      <button type="button" data-testid="set-light" onClick={() => setPreference('light')}>
        Light
      </button>
    </div>
  );
}

describe('ThemeContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    api.updateThemePreference.mockResolvedValue({});
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-color-scheme: dark') ? false : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to system theme', () => {
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('system');
  });

  it('setPreference updates preference state', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByTestId('set-dark'));
    expect(screen.getByTestId('preference')).toHaveTextContent('dark');

    await user.click(screen.getByTestId('set-light'));
    expect(screen.getByTestId('preference')).toHaveTextContent('light');
  });

  it('saves to localStorage', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByTestId('set-dark'));
    expect(localStorage.getItem('theme-preference')).toBe('dark');
  });

  it('handles localStorage failure gracefully', async () => {
    const user = userEvent.setup();
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    render(
      <ThemeProvider>
        <TestConsumer />
      </ThemeProvider>,
    );

    await user.click(screen.getByTestId('set-dark'));
    expect(screen.getByTestId('preference')).toHaveTextContent('dark');

    setItemSpy.mockRestore();
  });
});
