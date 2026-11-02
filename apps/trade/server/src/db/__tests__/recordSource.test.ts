import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@trade-request/shared';

const { localPool, scoped, meta } = vi.hoisted(() => ({
  localPool: { query: vi.fn() },
  scoped: { query: vi.fn() },
  meta: { isConfigured: vi.fn(), getClientAccounts: vi.fn() },
}));
vi.mock('../pool.js', () => ({ default: localPool }));
vi.mock('../../services/warehouse.js', () => meta);
vi.mock('../../lib/logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { recordDb, withRecordDb } from '../recordSource.js';
import { OpsPortalRecordsUnavailableError } from '../opsPortalRecords.js';
import {
  findLastAllocationForClient,
  getLastAllocation,
  getRequestCounts,
  listRequests,
} from '../../services/requestQueries.js';
import { loadAccountExclusionsForRequests, loadStandingClientExclusions } from '../../services/pdfExports.js';

const advisor = { id: 'advisor-uuid', role: 'advisor', email: 'advisor@example.test' } as AuthUser;

beforeEach(() => {
  localPool.query.mockReset().mockResolvedValue({ rows: [] });
  scoped.query.mockReset().mockResolvedValue({ rows: [] });
  meta.isConfigured.mockReset().mockReturnValue(false);
  meta.getClientAccounts.mockReset().mockResolvedValue([]);
});

describe('record source scope', () => {
  it('is the local pool outside any scope', () => {
    expect(recordDb()).toBe(localPool);
  });

  it('is the scoped database across awaits and parallel work, and only inside the scope', async () => {
    const seen = await withRecordDb(scoped, async () => {
      await Promise.resolve();
      return Promise.all([Promise.resolve().then(() => recordDb()), recordDb()]);
    });
    expect(seen).toEqual([scoped, scoped]);
    expect(recordDb()).toBe(localPool);
  });

  it('sends every MCP record read to the scoped database', async () => {
    scoped.query.mockResolvedValueOnce({ rows: [] }); // counts
    scoped.query.mockResolvedValueOnce({ rows: [] }); // list (empty page, no audit read)
    scoped.query.mockResolvedValueOnce({ rows: [{ ok: 1 }] }); // ownership probe
    scoped.query.mockResolvedValueOnce({ rows: [] }); // last allocation
    scoped.query.mockResolvedValueOnce({ rows: [] }); // last allocation (direct)
    scoped.query.mockResolvedValueOnce({ rows: [] }); // standing client exclusions
    await withRecordDb(scoped, async () => {
      await getRequestCounts(advisor);
      await listRequests(advisor, { limit: 5 });
      await getLastAllocation(advisor, 'HH-001');
      await findLastAllocationForClient('HH-001');
      await loadStandingClientExclusions(['HH-001']);
    });
    expect(scoped.query).toHaveBeenCalledTimes(6);
    expect(localPool.query).not.toHaveBeenCalled();
  });

  it('propagates an advisor platform read failure from the account-exclusion lookup instead of rendering without it', async () => {
    meta.isConfigured.mockReturnValue(true);
    meta.getClientAccounts.mockResolvedValue([
      { id: 'acct-1', clientId: 'HH-001', accountNumber: 'ACC-1', accountType: 'Taxable', balance: 0, holdings: {} },
    ]);
    scoped.query.mockRejectedValueOnce(new OpsPortalRecordsUnavailableError());
    const request = { id: 'REQ-1', clientId: 'HH-001', clientIds: ['HH-001'], selectedAccounts: ['ACC-1'] };
    await expect(
      withRecordDb(scoped, () => loadAccountExclusionsForRequests([request as never])),
    ).rejects.toBeInstanceOf(OpsPortalRecordsUnavailableError);
    scoped.query.mockRejectedValueOnce(new Error('other failure'));
    await expect(withRecordDb(scoped, () => loadAccountExclusionsForRequests([request as never]))).resolves.toEqual({});
  });
});
