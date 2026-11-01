import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: getMock,
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    })),
    isAxiosError: vi.fn(() => false),
    isCancel: vi.fn(() => false),
  },
}));

const { fetchServiceMode } = await import('../client');

beforeEach(() => {
  getMock.mockReset();
});

describe('fetchServiceMode', () => {
  it('returns the mode the service reports', async () => {
    getMock.mockResolvedValueOnce({ data: { mode: 'mcp-only' } });
    expect(await fetchServiceMode()).toBe('mcp-only');
    expect(getMock).toHaveBeenCalledWith('/service-mode');
  });

  it('shows the full app when the mode cannot be read', async () => {
    getMock.mockRejectedValueOnce(new Error('network'));
    expect(await fetchServiceMode()).toBe('active');
  });
});
