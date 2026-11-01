import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
});
vi.mock('../../db/pool.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

const { isDelegatedOperationAllowed } = await import('../delegated.js');

// TDD §4.2: exactly the operations the Ops Portal Trade Requests workspace uses.
describe('isDelegatedOperationAllowed — /api/ops-portal operation allowlist', () => {
  it.each([
    ['GET', '/requests'],
    ['GET', '/requests/counts'],
    ['GET', '/requests/last-allocation/CLIENT-1'],
    ['GET', '/requests/TR-1'],
    ['POST', '/requests'],
    ['PUT', '/requests/TR-1'],
    ['GET', '/requests/TR-1/checklist'],
    ['PUT', '/requests/TR-1/checklist'],
    ['PUT', '/requests/TR-1/status'],
    ['GET', '/notifications'],
    ['PATCH', '/notifications/n-1/read'],
    ['POST', '/notifications/read-all'],
    ['GET', '/clients'],
    ['GET', '/clients/exclusions/export'],
    ['POST', '/clients/exclusions/bulk'],
    ['POST', '/clients/account-exclusions/bulk'],
    ['POST', '/clients/account-exclusions/ACCT-1/batch'],
    ['GET', '/clients/CLIENT-1/exclusions'],
    ['POST', '/clients/CLIENT-1/exclusions'],
    ['POST', '/clients/CLIENT-1/exclusions/batch'],
    ['DELETE', '/clients/CLIENT-1/exclusions/42'],
    ['GET', '/households/resolve'],
  ])('allows %s %s', (method, path) => {
    expect(isDelegatedOperationAllowed(method, path)).toBe(true);
  });

  it('matches the way Express routes do: any letter case, optional trailing slash, HEAD as GET', () => {
    expect(isDelegatedOperationAllowed('GET', '/Requests/TR-1/Checklist/')).toBe(true);
    expect(isDelegatedOperationAllowed('HEAD', '/requests')).toBe(true);
    expect(isDelegatedOperationAllowed('put', '/requests/TR-1/status')).toBe(true);
  });

  it.each([
    ['POST', '/requests/TR-1/run-engine'],
    ['POST', '/requests/TR-1/RUN-ENGINE/'],
    ['GET', '/requests/TR-1/classified-holdings'],
    ['GET', '/Requests/TR-1/Household-Holdings'],
    ['DELETE', '/requests/TR-1'],
    ['GET', '/users'],
    ['PATCH', '/users/u-1/role'],
    ['GET', '/drift'],
    ['GET', '/machine/trade-requests'],
    ['GET', '/me/mcp-tokens'],
    ['GET', '/requests/TR-1/extra/segment'],
    ['POST', '/notifications'],
    ['GET', '/'],
  ])('refuses %s %s', (method, path) => {
    expect(isDelegatedOperationAllowed(method, path)).toBe(false);
  });
});
