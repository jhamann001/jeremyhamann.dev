import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthUser } from '@trade-request/shared';
import { StrictMode } from 'react';
import { AuthProvider, useAuth } from '../AuthContext';

const api = vi.hoisted(() => ({
  fetchCurrentUser: vi.fn(),
  logout: vi.fn(),
  extractApiError: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  fetchCurrentUser: () => api.fetchCurrentUser(),
  logout: () => api.logout(),
  extractApiError: (err: unknown, fallback?: string) => api.extractApiError(err, fallback),
}));

const mockUser: AuthUser = {
  id: '1',
  name: 'Test User',
  email: 't@test.com',
  googleId: 'g1',
  picture: null,
  role: 'advisor',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function TestConsumer() {
  const { user, loading, error, logout } = useAuth();
  return (
    <div>
      {loading && <span data-testid="loading">Loading</span>}
      {error && <span data-testid="error">{error}</span>}
      {user && <span data-testid="user">{user.name}</span>}
      <button type="button" data-testid="logout" onClick={logout}>
        Logout
      </button>
    </div>
  );
}

describe('AuthContext', () => {
  let locationHref = '';

  beforeEach(() => {
    vi.clearAllMocks();
    locationHref = '';
    Object.defineProperty(window, 'location', {
      configurable: true,
      enumerable: true,
      value: {
        get href() {
          return locationHref || 'http://localhost/';
        },
        set href(v: string) {
          locationHref = v;
        },
      },
    });
  });

  it('AuthProvider renders children', async () => {
    api.fetchCurrentUser.mockResolvedValue(null);
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId('loading')).not.toBeInTheDocument());
    expect(screen.getByTestId('logout')).toBeInTheDocument();
  });

  it('clears loading under StrictMode when no user is authenticated', async () => {
    api.fetchCurrentUser.mockResolvedValue(null);

    render(
      <StrictMode>
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.queryByTestId('loading')).not.toBeInTheDocument());
    expect(screen.getByTestId('logout')).toBeInTheDocument();
  });

  it('shows loading state initially', async () => {
    let resolveUser!: (u: AuthUser | null) => void;
    const pending = new Promise<AuthUser | null>((r) => {
      resolveUser = r;
    });
    api.fetchCurrentUser.mockReturnValue(pending);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    expect(screen.getByTestId('loading')).toBeInTheDocument();

    resolveUser(mockUser);
    await waitFor(() => expect(screen.queryByTestId('loading')).not.toBeInTheDocument());
    expect(screen.getByTestId('user')).toHaveTextContent('Test User');
  });

  it('sets user after fetchCurrentUser resolves', async () => {
    api.fetchCurrentUser.mockResolvedValue(mockUser);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('Test User'));
    expect(api.fetchCurrentUser).toHaveBeenCalled();
  });

  it('sets error when fetchCurrentUser rejects', async () => {
    const err = new Error('network down');
    api.fetchCurrentUser.mockRejectedValue(err);
    api.extractApiError.mockReturnValue('network down');

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('network down'));
    expect(api.extractApiError).toHaveBeenCalled();
  });

  it('logout calls apiLogout and redirects', async () => {
    api.fetchCurrentUser.mockResolvedValue(null);
    api.logout.mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.queryByTestId('loading')).not.toBeInTheDocument());
    await user.click(screen.getByTestId('logout'));

    await waitFor(() => expect(api.logout).toHaveBeenCalled());
    expect(locationHref).toBe('/login');
  });
});
