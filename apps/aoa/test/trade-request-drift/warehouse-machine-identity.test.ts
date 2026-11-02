import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { classification, logger } = vi.hoisted(() => ({
  classification: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/trade-requests/sources/security-sector', () => ({ getClassificationMap: classification }));
vi.mock('@/lib/trade-requests/log', () => ({ default: logger }));

const TTL = 30 * 60 * 1000;
const TIMEOUT = 5_000;
const unavailable = 'Machine account identity unavailable';

function contact(id: unknown, stage: unknown = 'Client') {
  return { cedar_ridge_user_id__c: id, name: 'Synthetic client', crm__primary_entity_stage__c: stage };
}

function investment(number: unknown, id: unknown, owner: unknown = 'user-1') {
  return {
    user_id: owner,
    custodian_account_number: number,
    custodian_account_id: id,
    account_type: 'BROKERAGE',
  };
}

function okJson(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function identityFetch(
  contacts: unknown = [contact('user-1')],
  investments: unknown = [investment('QYOI-915', 'apex-1'), investment('BUSG-914', 'apex-2')],
) {
  const mock = vi.fn(async (url: string | URL | Request, _options?: RequestInit) => {
    if (String(url) === 'https://warehouse.test/api/card/6043/query/json') return okJson(contacts);
    if (String(url) === 'https://warehouse.test/api/card/6040/query/json') return okJson(investments);
    throw new Error('Unexpected non-identity request');
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function expectIdentityRequests(mock: ReturnType<typeof identityFetch>, count = 2) {
  expect(mock).toHaveBeenCalledTimes(count);
  expect(mock.mock.calls.map(([url]) => String(url))).toEqual(
    Array.from({ length: count / 2 }, () => [
      'https://warehouse.test/api/card/6043/query/json',
      'https://warehouse.test/api/card/6040/query/json',
    ]).flat(),
  );
  expect(classification).not.toHaveBeenCalled();
}

describe('machine account identity cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
    vi.stubEnv('WAREHOUSE_URL', 'https://warehouse.test/');
    vi.stubEnv('WAREHOUSE_API_KEY', 'synthetic-key');
    vi.stubEnv('WAREHOUSE_CONTACTS_QUESTION_ID', '6043');
    vi.stubEnv('WAREHOUSE_INVESTMENTS_QUESTION_ID', '6040');
    vi.stubEnv('WAREHOUSE_BALANCES_QUESTION_ID', '6042');
    vi.stubEnv('WAREHOUSE_STOCK_RECORD_QUESTION_ID', '6139');
    classification.mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('checks only identity configuration without requests and preserves the full-client configuration gate', async () => {
    const fetchMock = identityFetch();
    const { isConfigured, isMachineAccountIdentityConfigured } = await import('@/lib/trade-requests/sources/warehouse');
    expect(isConfigured()).toBe(true);
    expect(isMachineAccountIdentityConfigured()).toBe(true);
    vi.stubEnv('WAREHOUSE_BALANCES_QUESTION_ID', '');
    vi.stubEnv('WAREHOUSE_STOCK_RECORD_QUESTION_ID', '');
    expect(isConfigured()).toBe(false);
    expect(isMachineAccountIdentityConfigured()).toBe(true);
    vi.stubEnv('WAREHOUSE_CONTACTS_QUESTION_ID', '');
    expect(isMachineAccountIdentityConfigured()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads only contacts and investments on cold/expired caches and reuses the 30-minute cache', async () => {
    const fetchMock = identityFetch();
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');

    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    expectIdentityRequests(fetchMock);
    vi.setSystemTime(Date.now() + TTL - 1);
    expect(await getMachineAccountIdMap(['BUSG-914', 'UNKNOWN'])).toEqual({ 'BUSG-914': 'apex-2' });
    expectIdentityRequests(fetchMock);
    vi.setSystemTime(Date.now() + 1);
    expect(await getMachineAccountIdMap(['BUSG-914'])).toEqual({ 'BUSG-914': 'apex-2' });
    expectIdentityRequests(fetchMock, 4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does no work for empty inputs, including during an in-flight refresh', async () => {
    const blocked = deferred<Response>();
    const fetchMock = vi.fn(() => blocked.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');

    expect(await getMachineAccountIdMap([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    const pending = getMachineAccountIdMap(['QYOI-915']);
    expect(await getMachineAccountIdMap([])).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    blocked.resolve(okJson([]));
    expect(await pending).toEqual({});
  });

  it('shares concurrent batch refreshes and returns only each caller’s requested numbers', async () => {
    const contacts = deferred<unknown>();
    const fetchMock = identityFetch();
    fetchMock.mockImplementationOnce(async () => ({ ...okJson([]), json: () => contacts.promise }));
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');

    const first = getMachineAccountIdMap(['QYOI-915', 'QYOI-915']);
    const second = getMachineAccountIdMap(['BUSG-914', 'UNKNOWN']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    contacts.resolve([contact('user-1')]);
    expect(await Promise.all([first, second])).toEqual([{ 'QYOI-915': 'apex-1' }, { 'BUSG-914': 'apex-2' }]);
    expectIdentityRequests(fetchMock);
    const mutable = await getMachineAccountIdMap(['QYOI-915']);
    mutable['QYOI-915'] = 'caller-mutation';
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
  });

  it('does not wait for an in-flight full client refresh or add holdings/classification reads', async () => {
    const balances = deferred<Response>();
    const stock = deferred<Response>();
    const fetchMock = identityFetch();
    const onlyIdentity = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, options) => {
      if (String(url).includes('/card/6042/')) return balances.promise;
      if (String(url).includes('/card/6139/')) return stock.promise;
      return onlyIdentity(url, options);
    });
    const { getCachedClients, getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    const fullRefresh = getCachedClients();
    const fullRefreshCalls = fetchMock.mock.calls.length;
    expect(fullRefreshCalls).toBe(4);
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    expect(fetchMock.mock.calls.slice(fullRefreshCalls).map(([url]) => String(url))).toEqual([
      'https://warehouse.test/api/card/6043/query/json',
      'https://warehouse.test/api/card/6040/query/json',
    ]);
    expect(classification).not.toHaveBeenCalled();
    balances.resolve(okJson([]));
    stock.resolve(okJson([]));
    await fullRefresh;
    expect(classification).toHaveBeenCalledTimes(1);
  });

  it('leaves the existing getAccountIdMap on the full client/holdings path', async () => {
    const fetchMock = identityFetch();
    const onlyIdentity = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, options) => {
      if (/\/card\/(6042|6139)\//.test(String(url))) return okJson([]);
      return onlyIdentity(url, options);
    });
    const { getAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    expect(await getAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(classification).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing exact number and Client eligibility scope, allowing duplicate joint owners', async () => {
    const fetchMock = identityFetch(
      [contact('user-1'), contact('joint-owner'), contact('prospect', 'Prospect'), contact('lowercase', 'client')],
      [
        investment('QYOI-915', 'apex-1'),
        investment('QYOI-915', 'apex-1'),
        investment('QYOI-915', 'apex-1', 'joint-owner'),
        investment('QYOI-915', 'out-of-scope-conflict', 'prospect'),
        investment('PROSPECT', 'apex-prospect', 'prospect'),
        investment('MISSING', 'apex-missing', 'missing-owner'),
        investment('LOWERCASE', 'apex-lowercase', 'lowercase'),
        investment('000123', 'apex-leading-zero'),
        investment(' MixedCase ', 'apex-spaces'),
      ],
    );
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    expect(
      await getMachineAccountIdMap([
        'QYOI-915',
        'acct-001',
        'PROSPECT',
        'MISSING',
        'LOWERCASE',
        '000123',
        '123',
        'MixedCase',
        ' MixedCase ',
      ]),
    ).toEqual({ 'QYOI-915': 'apex-1', '000123': 'apex-leading-zero', ' MixedCase ': 'apex-spaces' });
    expectIdentityRequests(fetchMock);
  });

  it('retains safe integer scalar compatibility without rounding or guessing IDs', async () => {
    identityFetch([contact(123)], [investment(456, 789, 123)]);
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    expect(await getMachineAccountIdMap(['456', '0456'])).toEqual({ '456': '789' });
  });

  it('keeps conflicting IDs unresolved regardless of row order or later duplicates', async () => {
    identityFetch(
      [contact('user-1'), contact('joint-owner')],
      [
        investment('CONFLICT-A', 'apex-1'),
        investment('CONFLICT-A', 'apex-2', 'joint-owner'),
        investment('CONFLICT-A', 'apex-1'),
        investment('CONFLICT-B', 'apex-2'),
        investment('CONFLICT-B', 'apex-1'),
        investment('GOOD', 'apex-good'),
      ],
    );
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    expect(await getMachineAccountIdMap(['CONFLICT-A', 'CONFLICT-B', 'GOOD'])).toEqual({ GOOD: 'apex-good' });
  });

  it('does not coerce malformed identifiers into identities or recover an ambiguous malformed ID', async () => {
    const invalid = [
      null,
      undefined,
      '',
      '  ',
      'null',
      'undefined',
      {},
      [],
      true,
      false,
      NaN,
      Infinity,
      1.5,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    identityFetch(
      [contact('user-1'), ...invalid.map((id) => contact(id))],
      [
        ...invalid.flatMap((value, index) => [
          investment(`BAD-ID-${index}`, value),
          investment(`BAD-ID-${index}`, 'later-valid-id'),
          { ...investment(`BAD-OWNER-${index}`, 'apex-1'), user_id: value },
          investment(value, 'apex-1'),
        ]),
        investment('LATE-NULL', 'apex-valid'),
        investment('LATE-NULL', null),
        null,
        ['not-a-row'],
        { custodian_account_number: 'MISSING-FIELDS' },
        investment('GOOD', 'apex-good'),
      ],
    );
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    const numbers = invalid.flatMap((value, index) => [`BAD-ID-${index}`, `BAD-OWNER-${index}`, String(value)]);
    expect(await getMachineAccountIdMap([...numbers, 'LATE-NULL', 'MISSING-FIELDS', 'GOOD'])).toEqual({
      GOOD: 'apex-good',
    });
    for (const method of Object.values(logger)) expect(method).not.toHaveBeenCalled();
  });

  it('treats object prototype names as exact data keys without inventing inherited matches', async () => {
    identityFetch([contact('user-1')], [investment('__proto__', 'apex-special')]);
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    const result = await getMachineAccountIdMap(['__proto__', 'constructor', 'toString']);
    expect(Object.keys(result)).toEqual(['__proto__']);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result['__proto__']).toBe('apex-special');
    expect(result['constructor']).toBeUndefined();
    expect(result['toString']).toBeUndefined();
  });

  it.each(['fetch', 'body'] as const)(
    'bounds hanging %s plus concurrent callers at five seconds and prevents late cache fills',
    async (phase) => {
      const lateFetch = deferred<Response>();
      const lateBody = deferred<unknown>();
      const fetchMock = identityFetch();
      fetchMock.mockImplementation((url) => {
        if (String(url).includes('/card/6043/')) {
          return phase === 'fetch'
            ? lateFetch.promise
            : Promise.resolve({ ...okJson([]), json: () => lateBody.promise });
        }
        return Promise.resolve(okJson([investment('QYOI-915', 'late-apex-id')]));
      });
      const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
      const first = getMachineAccountIdMap(['QYOI-915']);
      let settled = false;
      const outcome = Promise.allSettled([first, getMachineAccountIdMap(['BUSG-914'])]).then((results) => {
        settled = true;
        return results;
      });
      await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const results = await outcome;
      expect(results).toEqual([
        { status: 'rejected', reason: new Error(unavailable) },
        { status: 'rejected', reason: new Error(unavailable) },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const signals = fetchMock.mock.calls.map(([, options]) => options!.signal!);
      expect(signals[0]).toBe(signals[1]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      // An immediate retry succeeds. The old transport ignores cancellation,
      // then resolves; its result must never replace the successful retry.
      const retryFetch = identityFetch([contact('user-1')], [investment('QYOI-915', 'fresh-apex-id')]);
      expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'fresh-apex-id' });
      lateFetch.resolve(okJson([contact('user-1')]));
      lateBody.resolve([contact('user-1')]);
      await vi.advanceTimersByTimeAsync(0);
      expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'fresh-apex-id' });
      expectIdentityRequests(retryFetch);
    },
  );

  it('shares one deadline across the fetch and response body stages', async () => {
    const headers = deferred<Response>();
    const body = deferred<unknown>();
    const fetchMock = identityFetch();
    fetchMock.mockImplementationOnce(() => headers.promise);
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    const outcome = Promise.allSettled([getMachineAccountIdMap(['QYOI-915'])]);
    await vi.advanceTimersByTimeAsync(4_000);
    headers.resolve({ ...okJson([]), json: () => body.promise });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toEqual([{ status: 'rejected', reason: new Error(unavailable) }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    body.resolve([contact('user-1')]);
  });

  it('does not cache a result whose synchronous body parsing already passed the deadline', async () => {
    const fetchMock = identityFetch();
    fetchMock.mockImplementationOnce(async () => ({
      ...okJson([]),
      json: async () => {
        vi.setSystemTime(Date.now() + TIMEOUT);
        return [contact('user-1')];
      },
    }));
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    await expect(getMachineAccountIdMap(['QYOI-915'])).rejects.toThrow(unavailable);
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    expectIdentityRequests(fetchMock, 4);
  });

  it('rejects an expired refresh failure without stale grace, then retries successfully', async () => {
    const fetchMock = identityFetch();
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    vi.setSystemTime(Date.now() + TTL);
    fetchMock.mockRejectedValueOnce(new Error('upstream-sensitive-payload'));
    await expect(getMachineAccountIdMap(['QYOI-915'])).rejects.toThrow(unavailable);
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    expectIdentityRequests(fetchMock, 6);
    for (const method of Object.values(logger)) expect(method).not.toHaveBeenCalled();
  });

  it.each([
    ['6043', { error: 'sensitive payload' }],
    ['6040', null],
  ])('rejects a non-array %s payload instead of caching an authoritative empty map', async (question, payload) => {
    const fetchMock = identityFetch();
    const defaultFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, options) =>
      String(url).includes(`/card/${question}/`) ? okJson(payload) : defaultFetch(url, options),
    );
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    await expect(getMachineAccountIdMap(['QYOI-915'])).rejects.toThrow(unavailable);
    fetchMock.mockImplementation(defaultFetch);
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    expectIdentityRequests(fetchMock, 4);
  });

  it('rejects malformed JSON with a sanitized error and clears the in-flight refresh', async () => {
    const fetchMock = identityFetch();
    fetchMock.mockImplementationOnce(async () => ({
      ...okJson([]),
      json: async () => {
        throw new Error('sensitive account payload in parse error');
      },
    }));
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    await expect(getMachineAccountIdMap(['QYOI-915'])).rejects.toThrow(unavailable);
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    expectIdentityRequests(fetchMock, 4);
    for (const method of Object.values(logger)) expect(method).not.toHaveBeenCalled();
  });

  it('does not read a hanging HTTP error body and cancels sibling requests without retrying', async () => {
    const readBody = vi.fn(() => new Promise<string>(() => {}));
    const fetchMock = identityFetch();
    fetchMock.mockImplementation(async () => ({ ...okJson([]), ok: false, status: 502, text: readBody }));
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    await expect(getMachineAccountIdMap(['QYOI-915'])).rejects.toThrow(unavailable);
    expect(readBody).not.toHaveBeenCalled();
    expectIdentityRequests(fetchMock);
    expect(fetchMock.mock.calls.every(([, options]) => options!.signal!.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    for (const method of Object.values(logger)) expect(method).not.toHaveBeenCalled();
  });

  it('requires only identity source configuration, with no balance/stock requirement', async () => {
    vi.stubEnv('WAREHOUSE_BALANCES_QUESTION_ID', '');
    vi.stubEnv('WAREHOUSE_STOCK_RECORD_QUESTION_ID', '');
    const fetchMock = identityFetch();
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
    expectIdentityRequests(fetchMock);
  });

  it('rejects missing identity configuration without requests and still allows an empty input', async () => {
    vi.stubEnv('WAREHOUSE_CONTACTS_QUESTION_ID', '');
    const fetchMock = identityFetch();
    const { getMachineAccountIdMap } = await import('@/lib/trade-requests/sources/warehouse');
    expect(await getMachineAccountIdMap([])).toEqual({});
    await expect(getMachineAccountIdMap(['QYOI-915'])).rejects.toThrow('Machine account identity is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('WAREHOUSE_CONTACTS_QUESTION_ID', '6043');
    expect(await getMachineAccountIdMap(['QYOI-915'])).toEqual({ 'QYOI-915': 'apex-1' });
  });
});
