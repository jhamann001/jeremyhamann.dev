import { vi } from 'vitest';
import type { AuthUser } from '@trade-request/shared';

export const traderUser: AuthUser = {
  id: 'trader-uuid',
  googleId: 'g-trader',
  email: 'trader@example.com',
  name: 'Test Trader',
  picture: null,
  role: 'trader',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

export const advisorUser: AuthUser = {
  id: 'advisor-uuid',
  googleId: 'g-advisor',
  email: 'advisor@example.com',
  name: 'Test Advisor',
  picture: null,
  role: 'advisor',
  slackUserId: null,
  themePreference: 'system',
  isActive: true,
  lastLogin: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

export interface MockPoolClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

export function createMockPoolClient(): MockPoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
}

export function createMockPool() {
  const poolClient = createMockPoolClient();
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue(poolClient),
    end: vi.fn(),
    _client: poolClient,
  };
}
