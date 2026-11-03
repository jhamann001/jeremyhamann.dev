import { describe, expect, it } from 'vitest';
import {
  bodyWithinLimit,
  CONTENT_SECURITY_POLICY,
  forwardableHeaders,
  MAX_BODY_BYTES,
  PRIVATE_PATHS,
  routedPath,
  visitorKey,
  visitorPseudonym,
  STRICT_TRANSPORT_SECURITY,
  withDemoHeaders,
} from './rules.js';

const isPrivate = (pathname) => PRIVATE_PATHS.test(routedPath(pathname));

describe('the Statement Analyzer Worker', () => {
  it('keeps the scan, scheduler, machine, MCP, docs and reset routes private, however they are spelled', () => {
    for (const p of [
      '/scan',
      '/api/scan',
      '/api/schedule-status',
      '/api/destinations/backfill',
      '/api/staleness/backfill',
      '/api/v1/positions',
      '/api/v1/clients/x/destinations',
      '/api/mcp-tokens',
      '/api/mcp-tokens/0b9f',
      '/mcp',
      '/mcp/',
      '/docs',
      '/docs/oauth2-redirect',
      '/redoc',
      '/openapi.json',
      '/api/internal/demo-reset',
      '/API/Internal/demo-reset',
      '//api//internal/demo-reset',
      '/api/%69nternal/demo-reset',
      '/api/v1%2Fpositions',
    ]) {
      expect(isPrivate(p), p).toBe(true);
    }
  });

  it('leaves the pages, sign-in, health, samples and the visitor API open', () => {
    for (const p of [
      '/',
      '/theme.js',
      '/favicon.svg',
      '/health',
      '/api/health',
      '/api/config',
      '/api/me',
      '/api/households',
      '/api/samples',
      '/api/samples/run',
      '/api/samples/okafor/documents/statement.pdf',
      '/api/outbox',
      '/api/users',
      '/auth/persona',
      '/auth/sign-out',
      '/scanner',
      '/mcpx',
      '/documents',
    ]) {
      expect(isPrivate(p), p).toBe(false);
    }
    expect(routedPath('/%E0%A4%A')).toBeNull();
  });

  it('refuses a body over the cap, or with no declared length', () => {
    const post = (headers, body = 'x') =>
      new Request('https://statements.example/x', { method: 'POST', headers, body, duplex: 'half' });
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_BODY_BYTES + 1)));
        controller.close();
      },
    });
    expect(MAX_BODY_BYTES).toBe(128 * 1024);
    expect(bodyWithinLimit(new Request('https://statements.example/'))).toBe(true);
    expect(bodyWithinLimit(new Request('https://statements.example/auth/sign-out', { method: 'POST' }))).toBe(true);
    expect(bodyWithinLimit(post({ 'content-length': '1' }))).toBe(true);
    expect(bodyWithinLimit(post({ 'content-length': String(MAX_BODY_BYTES + 1) }))).toBe(false);
    expect(bodyWithinLimit(post({}, streamed))).toBe(false);
    expect(bodyWithinLimit(post({}))).toBe(false);
    expect(bodyWithinLimit(post({ 'content-length': ' ' }))).toBe(false);
  });

  it("drops the visitor's address, location and routing headers, and keeps the rest", () => {
    const headers = forwardableHeaders(
      new Headers({
        'cf-container-target-port': '9000',
        'cf-connecting-ip': '198.51.100.1',
        'cf-connecting-ipv6': '2001:db8::1',
        'cf-ipcountry': 'US',
        'cf-ipcity': 'Springfield',
        'true-client-ip': '198.51.100.1',
        forwarded: 'for=198.51.100.1',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-port': '9000',
        'x-real-ip': '198.51.100.1',
        cookie: 'stmt_session=v1.a.b',
        'sec-fetch-site': 'same-origin',
      }),
    );
    expect([...headers.keys()].sort()).toEqual(['cookie', 'sec-fetch-site']);
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

  it('puts pages under the policy, and every answer out of search engines', async () => {
    const page = withDemoHeaders(
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );
    expect(page.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('strict-transport-security')).toBe(STRICT_TRANSPORT_SECURITY);
    expect(await page.text()).toBe('<html></html>');

    const api = withDemoHeaders(new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }));
    expect(api.status).toBe(201);
    expect(api.headers.get('content-security-policy')).toBeNull();
    expect(api.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(api.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
  });

  it("allows only the app itself, Google Fonts and Cloudflare's analytics beacon, and no framing", () => {
    const directives = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split(';').map((d) => {
        const [name, ...sources] = d.trim().split(/\s+/);
        return [name, sources];
      }),
    );
    expect(directives['script-src']).toEqual(["'self'", 'https://static.cloudflareinsights.com']);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['font-src']).toEqual(['https://fonts.gstatic.com']);
    expect(directives['style-src']).toEqual(["'self'", 'https://fonts.googleapis.com']);
  });
});
