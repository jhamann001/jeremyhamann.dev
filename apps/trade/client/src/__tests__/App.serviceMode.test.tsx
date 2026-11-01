import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AuthUser } from '@trade-request/shared';

// The standalone UI follows the service mode (ticket): frozen shows a read-only banner; MCP-only
// shows only Connected Apps and loads no Trade Request data.
const mocks = vi.hoisted(() => ({
  fetchServiceMode: vi.fn(),
  useTradeRequests: vi.fn(),
  useClients: vi.fn(),
}));

const USER: AuthUser = {
  id: 'u1',
  name: 'Synthetic Trader',
  email: 'trader@example.test',
  googleId: 'g',
  picture: null,
  role: 'trader',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: USER,
    actualUser: USER,
    loading: false,
    error: null,
    refresh: async () => {},
    logout: async () => {},
    roleOverride: null,
    isDemo: false,
    canDemo: false,
    toggleDemo: () => {},
  }),
}));
vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ preference: 'system', resolved: 'light', setPreference: () => {} }),
}));
vi.mock('../api/client', () => ({
  fetchServiceMode: mocks.fetchServiceMode,
  fetchAccountDriftHistory: vi.fn().mockResolvedValue({ runs: [] }),
  fetchAllRequests: vi.fn(),
  fetchBulkAccountExclusions: vi.fn(),
  fetchBulkClientExclusions: vi.fn(),
  fetchRequest: vi.fn(),
  extractApiError: () => 'error',
  invalidateLastAllocCache: vi.fn(),
}));
vi.mock('../hooks/useTradeRequests', () => ({
  useClients: () => {
    mocks.useClients();
    return { clients: [], clientMap: {}, loading: false, error: null };
  },
  useTradeRequests: () => {
    mocks.useTradeRequests();
    return {
      requests: [],
      loading: false,
      error: null,
      create: vi.fn(),
      update: vi.fn(),
      updateStatus: vi.fn(),
      refresh: vi.fn(),
      loadMore: vi.fn(),
      loadingMore: false,
      hasMore: false,
      queueSearchInput: '',
      setQueueSearchInput: vi.fn(),
    };
  },
}));
vi.mock('../hooks/useNotifications', () => ({
  useNotifications: () => ({
    notifications: [],
    unreadCount: 0,
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    pushEphemeral: vi.fn(),
  }),
}));
vi.mock('../components/SessionBanner', () => ({ SessionBanner: () => null }));
vi.mock('../components/DemoBanner', () => ({ DemoBanner: () => null }));
vi.mock('../components/DemoRoleSwitcher', () => ({ DemoRoleSwitcher: () => null }));
vi.mock('../components/HomePage', () => ({ HomePage: () => <div>Home page</div> }));
vi.mock('../components/ConnectedApps', () => ({ ConnectedApps: () => <div>Connected apps page</div> }));

import App from '../App';

const FROZEN = 'Trade Requests is briefly read-only while it is being moved — try again in a few minutes.';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('App and the service mode', () => {
  it('MCP-only: shows only Connected Apps and loads no Trade Request data', async () => {
    mocks.fetchServiceMode.mockResolvedValue('mcp-only');
    renderAt('/queue');
    expect(await screen.findByText('Connected apps page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trading Queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(mocks.useTradeRequests).not.toHaveBeenCalled();
    expect(mocks.useClients).not.toHaveBeenCalled();
  });

  it('frozen: shows the read-only banner above the usual screens', async () => {
    mocks.fetchServiceMode.mockResolvedValue('frozen');
    renderAt('/');
    expect(await screen.findByText(FROZEN)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Trading Queue' }).length).toBeGreaterThan(0);
  });

  it('active: shows every screen and no banner (today)', async () => {
    mocks.fetchServiceMode.mockResolvedValue('active');
    renderAt('/');
    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Trading Queue' }).length).toBeGreaterThan(0);
    expect(screen.queryByText(FROZEN)).not.toBeInTheDocument();
  });

  it('MCP-only: a deep link to a screen lands on Connected Apps', async () => {
    mocks.fetchServiceMode.mockResolvedValue('mcp-only');
    renderAt('/new');
    expect(await screen.findByText('Connected apps page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Request' })).not.toBeInTheDocument();
  });
});
