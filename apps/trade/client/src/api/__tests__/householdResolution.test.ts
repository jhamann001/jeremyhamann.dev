import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInstance, mockAuthInstance } = vi.hoisted(() => ({
  mockInstance: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  },
  mockAuthInstance: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  },
}));

vi.mock('axios', () => {
  let createCallCount = 0;
  return {
    default: {
      create: vi.fn(() => {
        createCallCount++;
        return createCallCount <= 1 ? mockInstance : mockAuthInstance;
      }),
      get: vi.fn(),
      post: vi.fn(),
      isAxiosError: vi.fn((err: unknown) => err instanceof Error && 'response' in err),
    },
  };
});

import { fetchHouseholdResolution } from '../client';

const VALID_ULID = '01SYNTHJ7G094TRY2A6R126CB3';

beforeEach(() => {
  mockInstance.get.mockReset();
});

describe('fetchHouseholdResolution', () => {
  it('returns the resolved households on 200', async () => {
    mockInstance.get.mockResolvedValue({
      data: {
        data: {
          households: [
            {
              householdId: 100,
              householdName: 'Alpha Household',
              accounts: [
                {
                  accountId: VALID_ULID,
                  accountNumber: 'ACCT-1',
                  accountTitle: 'Alpha',
                  clientId: 'CLI-1',
                  accountType: 'Taxable',
                  balance: 100_000,
                },
              ],
              selectedAccountIds: [VALID_ULID],
              clientIds: ['CLI-1'],
            },
          ],
          unresolvedClientIds: [],
          unresolvedAccountIds: [],
        },
      },
    });

    const result = await fetchHouseholdResolution({ clientIds: ['CLI-1'], accountIds: [] });
    expect(result.households).toHaveLength(1);
    expect(result.households[0].householdId).toBe(100);
    expect(mockInstance.get).toHaveBeenCalledWith('/households/resolve?clientIds=CLI-1', expect.objectContaining({}));
  });

  it('returns empty households on 503 without rethrowing (silent-fallback contract)', async () => {
    const err = Object.assign(new Error('Service Unavailable'), {
      response: { status: 503, data: { error: 'household_data_unavailable' } },
    });
    mockInstance.get.mockRejectedValue(err);

    const result = await fetchHouseholdResolution({
      clientIds: ['CLI-1'],
      accountIds: [VALID_ULID],
    });

    expect(result).toEqual({
      households: [],
      unresolvedClientIds: ['CLI-1'],
      unresolvedAccountIds: [VALID_ULID],
    });
  });

  it('rethrows non-503 errors (do not silently swallow 4xx/5xx)', async () => {
    const err = Object.assign(new Error('Internal Server Error'), {
      response: { status: 500, data: { error: 'boom' } },
    });
    mockInstance.get.mockRejectedValue(err);

    await expect(fetchHouseholdResolution({ clientIds: ['CLI-1'], accountIds: [] })).rejects.toBe(err);
  });

  it('rethrows schema validation failures so a bad server response is not silently rendered', async () => {
    mockInstance.get.mockResolvedValue({
      data: { data: { households: [{ thisShape: 'is wrong' }] } },
    });
    await expect(fetchHouseholdResolution({ clientIds: ['CLI-1'], accountIds: [] })).rejects.toThrow();
  });

  it('omits empty query parameters from the URL', async () => {
    mockInstance.get.mockResolvedValue({
      data: { data: { households: [], unresolvedClientIds: [], unresolvedAccountIds: [] } },
    });
    await fetchHouseholdResolution({ clientIds: [], accountIds: [] });
    expect(mockInstance.get).toHaveBeenCalledWith('/households/resolve', expect.objectContaining({}));
  });
});
