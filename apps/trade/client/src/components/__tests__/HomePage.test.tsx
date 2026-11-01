import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HomePage } from '../HomePage';
import type { AuthUser } from '@trade-request/shared';

const mockFetchRequestCounts = vi.fn();

vi.mock('../../api/client', () => ({
  fetchAppConfig: vi.fn().mockResolvedValue({ allowedDomains: ['test.com'], sessionTtlMs: 3600000 }),
  fetchRequestCounts: (...args: unknown[]) => mockFetchRequestCounts(...args),
}));

const mockUser: AuthUser = {
  id: '1',
  name: 'Jane Doe',
  email: 'jane@test.com',
  googleId: null,
  picture: null,
  role: 'advisor',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('HomePage', () => {
  let onNavigate: ReturnType<typeof vi.fn<(view: string) => void>>;

  beforeEach(() => {
    onNavigate = vi.fn<(view: string) => void>();
    mockFetchRequestCounts.mockResolvedValue({ total: 79, pendingReview: 3, needsInfo: 1, approved: 74 });
  });

  it('greets the user by first name', () => {
    render(<HomePage user={mockUser} onNavigate={onNavigate} />);
    expect(screen.getByText('Welcome back, Jane')).toBeInTheDocument();
  });

  it('displays stats from the counts endpoint', async () => {
    render(<HomePage user={mockUser} onNavigate={onNavigate} />);

    await waitFor(() => {
      expect(screen.getByText('79')).toBeInTheDocument();
    });
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('74')).toBeInTheDocument();
  });

  it('navigates to form on "New Trade Request" click', () => {
    render(<HomePage user={mockUser} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('New Trade Request'));
    expect(onNavigate).toHaveBeenCalledWith('form');
  });

  it('navigates to queue on "Trading Queue" click', () => {
    render(<HomePage user={mockUser} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('Trading Queue'));
    expect(onNavigate).toHaveBeenCalledWith('queue');
  });

  it('shows loading skeletons before counts load', () => {
    mockFetchRequestCounts.mockReturnValue(new Promise(() => {}));
    const { container } = render(<HomePage user={mockUser} onNavigate={onNavigate} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});
