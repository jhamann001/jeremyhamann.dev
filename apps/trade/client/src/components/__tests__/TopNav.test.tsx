import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuthUser, Notification } from '@trade-request/shared';
import { TopNav } from '../TopNav';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useTheme: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => mocks.useAuth(),
}));

vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => mocks.useTheme(),
}));

const mockUser: AuthUser = {
  id: 'u1',
  name: 'Alex Advisor',
  email: 'alex@test.com',
  googleId: 'g',
  picture: null,
  role: 'advisor',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const emptyNotifications: Notification[] = [];

describe('TopNav', () => {
  let onViewChange: ReturnType<typeof vi.fn<(view: string) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    onViewChange = vi.fn<(view: string) => void>();
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
    mocks.useTheme.mockReturnValue({
      preference: 'system',
      resolved: 'light',
      setPreference: vi.fn(),
      saveError: false,
    });

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('min-width: 768px'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('renders user name', () => {
    render(
      <TopNav
        user={mockUser}
        activeView="home"
        onViewChange={onViewChange}
        notifications={emptyNotifications}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
      />,
    );
    expect(screen.getByText('Alex Advisor')).toBeInTheDocument();
  });

  it('renders navigation tabs', () => {
    render(
      <TopNav
        user={mockUser}
        activeView="home"
        onViewChange={onViewChange}
        notifications={emptyNotifications}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Request' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trading Queue' })).toBeInTheDocument();
  });

  it('calls onViewChange when tab clicked', async () => {
    const user = userEvent.setup();
    render(
      <TopNav
        user={mockUser}
        activeView="home"
        onViewChange={onViewChange}
        notifications={emptyNotifications}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Trading Queue' }));
    expect(onViewChange).toHaveBeenCalledWith('queue');
  });

  it('shows sign-out button', () => {
    render(
      <TopNav
        user={mockUser}
        activeView="home"
        onViewChange={onViewChange}
        notifications={emptyNotifications}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('renders the Drift tab for an advisor (access opened to all users) but NOT the trader-only Users tab', () => {
    render(
      <TopNav
        user={mockUser}
        activeView="home"
        onViewChange={onViewChange}
        notifications={emptyNotifications}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Drift' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Users' })).not.toBeInTheDocument();
  });

  it('renders the Drift tab for a trader and forwards the click', async () => {
    const user = userEvent.setup();
    const traderUser: AuthUser = { ...mockUser, role: 'trader' };
    render(
      <TopNav
        user={traderUser}
        activeView="home"
        onViewChange={onViewChange}
        notifications={emptyNotifications}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
      />,
    );
    const driftBtns = screen.getAllByRole('button', { name: 'Drift' });
    expect(driftBtns.length).toBeGreaterThan(0);
    await user.click(driftBtns[0]);
    expect(onViewChange).toHaveBeenCalledWith('drift');
  });

  it('highlights the Drift tab with a "new results" dot only when driftHasNewResults is set', () => {
    const { rerender } = render(
      <TopNav
        user={mockUser}
        activeView="home"
        onViewChange={onViewChange}
        notifications={emptyNotifications}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
        driftHasNewResults={false}
      />,
    );
    expect(screen.queryByLabelText('New drift results available today')).not.toBeInTheDocument();

    rerender(
      <TopNav
        user={mockUser}
        activeView="home"
        onViewChange={onViewChange}
        notifications={emptyNotifications}
        unreadCount={0}
        onMarkRead={() => {}}
        onMarkAllRead={() => {}}
        driftHasNewResults={true}
      />,
    );
    expect(screen.getAllByLabelText('New drift results available today').length).toBeGreaterThan(0);
  });
});
