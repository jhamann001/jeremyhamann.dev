import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/pool.js', () => ({ default: {} }));

import { mapRowToRequest, type DbAuditLogRow, type DbTradeRequestRow } from '../requestQueries.js';

const row = {
  id: 'REQ-CHANNEL1',
  client_id: 'client-1',
  client_name: 'Synthetic Client',
  advisor_id: 'advisor-1',
  advisor_name: 'Synthetic Advisor',
  trade_type: 'Raise Cash',
  status: 'Pending Review',
  created_at: new Date('2026-10-16T12:00:00.000Z'),
  updated_at: new Date('2026-10-16T12:00:00.000Z'),
  total_value: '0',
} as unknown as DbTradeRequestRow;

function auditRow(extra: Partial<DbAuditLogRow>): DbAuditLogRow {
  return {
    id: 'audit-1',
    request_id: row.id,
    created_at: new Date('2026-10-16T12:00:00.000Z'),
    user_name: 'Synthetic Person',
    action: 'Created Request',
    notes: null,
    ...extra,
  } as DbAuditLogRow;
}

describe('mapRowToRequest audit channel', () => {
  it('maps an advisor platform audit row to an entry marked opsPortal', () => {
    const request = mapRowToRequest(row, [auditRow({ channel: 'opsPortal' })]);
    expect(request.auditLog[0].channel).toBe('opsPortal');
  });

  it('marks an audit row without a channel as standalone', () => {
    const request = mapRowToRequest(row, [auditRow({})]);
    expect(request.auditLog[0].channel).toBe('standalone');
  });
});
