import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useNotifications } from '../useNotifications';

const mockFetch = vi.fn();
const mockMarkRead = vi.fn();
const mockMarkAll = vi.fn();

vi.mock('../../api/client', () => ({
  fetchNotifications: (...args: unknown[]) => mockFetch(...args),
  markNotificationRead: (...args: unknown[]) => mockMarkRead(...args),
  markAllNotificationsRead: (...args: unknown[]) => mockMarkAll(...args),
}));

describe('useNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ data: [], unreadCount: 0 });
  });

  it('loads notifications from API on mount', async () => {
    mockFetch.mockResolvedValueOnce({
      data: [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          message: 'Hello',
          isRead: false,
          date: '2026-01-01T00:00:00.000Z',
        },
      ],
      unreadCount: 1,
    });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => {
      expect(result.current.notifications.some((n) => n.message === 'Hello')).toBe(true);
    });
    expect(result.current.unreadCount).toBe(1);
  });

  it('pushEphemeral adds a local notification', async () => {
    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    act(() => result.current.pushEphemeral('Local error'));
    expect(result.current.notifications.some((n) => n.message === 'Local error')).toBe(true);
    expect(result.current.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it('markRead removes ephemeral notifications', async () => {
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    act(() => result.current.pushEphemeral('Ephemeral'));
    const ephem = result.current.notifications.find((n) => n.message === 'Ephemeral');
    expect(ephem).toBeDefined();

    await act(async () => {
      await result.current.markRead(ephem!.id);
    });
    expect(result.current.notifications.some((n) => n.message === 'Ephemeral')).toBe(false);
  });

  it('markRead calls API for server notifications', async () => {
    mockFetch.mockResolvedValueOnce({
      data: [
        {
          id: '550e8400-e29b-41d4-a716-446655440003',
          message: 'Server',
          isRead: false,
          date: '2026-01-01T00:00:00.000Z',
        },
      ],
      unreadCount: 1,
    });
    mockMarkRead.mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({ data: [], unreadCount: 0 });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => expect(result.current.notifications.some((n) => n.message === 'Server')).toBe(true));

    await act(async () => {
      await result.current.markRead('550e8400-e29b-41d4-a716-446655440003');
    });

    expect(mockMarkRead).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440003');
  });
});
