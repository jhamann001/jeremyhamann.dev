import { describe, expect, it, vi } from 'vitest';
import {
  GATE_PATH,
  gateUntil,
  gateUntilOrOpen,
  MAX_GATE_MINUTES,
  readGateChange,
  resettingResponse,
  showsResettingPage,
  tokensMatch,
} from './gate.js';

const TOKEN = 'k'.repeat(43);
const change = (body, { token = TOKEN, method = 'POST' } = {}) =>
  new Request(`https://example.test${GATE_PATH}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });

describe('the reset gate', () => {
  it('takes a change from the reset job, with its token', async () => {
    expect(await readGateChange(change({ minutes: 20 }), TOKEN)).toEqual({ ok: true, minutes: 20 });
    expect(await readGateChange(change({ minutes: 0 }), TOKEN)).toEqual({ ok: true, minutes: 0 });
  });

  it('answers anyone else as if there were nothing there', async () => {
    expect(await readGateChange(change({ minutes: 20 }, { token: 'wrong' }), TOKEN)).toEqual({ ok: false, status: 404 });
    expect(await readGateChange(change({ minutes: 20 }), '')).toEqual({ ok: false, status: 404 });
    expect(await readGateChange(change({ minutes: 20 }), undefined)).toEqual({ ok: false, status: 404 });
    expect(await readGateChange(change(null, { method: 'GET', token: 'wrong' }), TOKEN)).toEqual({ ok: false, status: 404 });
  });

  it('takes only POST from the reset job', async () => {
    expect(await readGateChange(change(null, { method: 'GET' }), TOKEN)).toEqual({ ok: false, status: 405 });
  });

  it('refuses a change it cannot read or that runs too long', async () => {
    for (const body of ['not json', { minutes: -1 }, { minutes: MAX_GATE_MINUTES + 1 }, { minutes: 1.5 }, { minutes: '5' }, {}]) {
      expect(await readGateChange(change(body), TOKEN), JSON.stringify(body)).toEqual({ ok: false, status: 400 });
    }
  });

  it('compares tokens exactly', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokensMatch(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
  });

  it('keeps the page up for the minutes asked, then lets it lapse on its own', () => {
    const now = 1_000_000;
    const until = gateUntil(20, now);
    expect(until).toBe(now + 20 * 60_000);
    expect(showsResettingPage(until, now, '/households')).toBe(true);
    expect(showsResettingPage(until, until + 1, '/households')).toBe(false);
    expect(showsResettingPage(gateUntil(0, now), now, '/households')).toBe(false);
  });

  it('reads the page as down when its state cannot be read, logging only a marker', async () => {
    expect(await gateUntilOrOpen(async () => 1234)).toBe(1234);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await gateUntilOrOpen(async () => { throw new Error('storage unavailable: secret detail'); })).toBe(0);
      expect(await gateUntilOrOpen(() => { throw new Error('no binding'); })).toBe(0);
      expect(logged.mock.calls).toEqual([['[aoa-gate] gate_read_failed'], ['[aoa-gate] gate_read_failed']]);
    } finally {
      logged.mockRestore();
    }
  });

  it('never hides the liveness check', () => {
    expect(showsResettingPage(gateUntil(20, 0), 0, '/api/health')).toBe(false);
  });

  it('shows a page that reloads itself and stays out of caches and search', async () => {
    const page = resettingResponse('https://portfolio.example');
    expect(page.status).toBe(503);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('retry-after')).toBe('60');
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    const html = await page.text();
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('https://portfolio.example');
  });
});
