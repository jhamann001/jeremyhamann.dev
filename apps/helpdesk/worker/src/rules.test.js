import { describe, expect, it } from 'vitest';
import {
  bodyWithinLimit,
  forwardableHeaders,
  MAX_BODY_BYTES,
  PRIVATE_PATHS,
  routedPath,
  visitorKey,
  visitorPseudonym,
} from './rules.js';

const isPrivate = (pathname) => PRIVATE_PATHS.test(routedPath(pathname));

describe('the help desk Worker', () => {
  it('keeps the machine routes private, however they are spelled', () => {
    for (const p of [
      '/api/integrations/outbox',
      '/api/ingest/email',
      '/api/client/tickets',
      '/api/mcp',
      '/api/push/subscribe',
      '/api/attachments/att-1/upload',
      '/api/attachments/a%2Fb/upload',
      '/api/export/tickets',
      '/API/Ingest/email',
      '//api//integrations/outbox',
      '/api/%69ngest/email',
    ]) {
      expect(isPrivate(p), p).toBe(true);
    }
  });

  it('leaves the pages, sign-in, health, staff exports and attachment downloads open', () => {
    for (const p of [
      '/',
      '/sign-in',
      '/api/health',
      '/api/auth/session',
      '/api/attachments/att-1/download',
      '/api/tickets/export',
      '/api/reports/export',
      '/api/compliance/audit/export',
      '/outbox',
    ]) {
      expect(isPrivate(p), p).toBe(false);
    }
    expect(routedPath('/%E0%A4%A')).toBeNull();
  });

  it('refuses a body over the cap, or with no declared length', () => {
    const post = (headers, body = 'x') =>
      new Request('https://helpdesk.example/x', { method: 'POST', headers, body, duplex: 'half' });
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_BODY_BYTES + 1)));
        controller.close();
      },
    });
    expect(bodyWithinLimit(new Request('https://helpdesk.example/'))).toBe(true);
    expect(bodyWithinLimit(post({ 'content-length': '1' }))).toBe(true);
    expect(bodyWithinLimit(post({ 'content-length': String(MAX_BODY_BYTES + 1) }))).toBe(false);
    expect(bodyWithinLimit(post({}, streamed))).toBe(false);
    expect(bodyWithinLimit(post({}))).toBe(false);
    expect(bodyWithinLimit(post({ 'content-length': ' ' }))).toBe(false);
  });

  it("drops the visitor's address and the headers a visitor may not set, and keeps the rest", () => {
    const headers = forwardableHeaders(
      new Headers({
        'cf-connecting-ip': '198.51.100.1',
        'cf-ipcountry': 'US',
        'true-client-ip': '198.51.100.1',
        'cf-container-target-port': '8090',
        forwarded: 'host=evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-port': '8090',
        'x-real-ip': '198.51.100.1',
        cookie: 'a=b',
        'content-type': 'application/json',
      }),
    );
    expect([...headers.keys()].sort()).toEqual(['content-type', 'cookie']);
  });

  it('keys an IPv6 visitor on the /64 network', () => {
    expect(visitorKey('203.0.113.7')).toBe('203.0.113.7');
    expect(visitorKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('tells the app a stable pseudonym in the documentation range, never the address', async () => {
    const a = await visitorPseudonym('203.0.113.7', 'k1');
    expect(a).toMatch(/^2001:db8(:[0-9a-f]{1,4}){6}$/);
    expect(a).not.toContain('203.0.113.7');
    expect(await visitorPseudonym('203.0.113.7', 'k1')).toBe(a);
    expect(await visitorPseudonym('203.0.113.8', 'k1')).not.toBe(a);
    expect(await visitorPseudonym('203.0.113.7', 'k2')).not.toBe(a);
  });
});
