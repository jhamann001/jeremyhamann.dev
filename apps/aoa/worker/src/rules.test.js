import { describe, expect, it } from 'vitest';
import {
  bodyWithinLimit,
  CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN,
  MAX_BODY_BYTES,
  PRIVATE_PATHS,
  routedPath,
  visitorKey,
  visitorPseudonym,
  withAnalyticsScript,
  WRITE_METHODS,
} from './rules.js';

describe('the Worker keeps the app private where it has no outside caller', () => {
  it('refuses the feeds, the scheduled jobs and the AI probe, however they are spelled', () => {
    for (const raw of ['/api/ingest/deals', '/api/cron/account-aum', '/api/health/ai', '/API/Ingest/x', '/api//cron/y', '/api/%69ngest/z']) {
      expect(PRIVATE_PATHS.test(routedPath(raw)), raw).toBe(true);
    }
  });

  it('lets the pages, the app API and the liveness check through', () => {
    for (const raw of ['/', '/command-center', '/api/health', '/api/trade-requests/notifications', '/api/ingestion', '/api/cronjobs']) {
      expect(PRIVATE_PATHS.test(routedPath(raw)), raw).toBe(false);
    }
  });

  it('refuses a malformed path', () => {
    expect(routedPath('/%E0%A4%A')).toBeNull();
  });
});

describe('per-visitor limits', () => {
  it('keys IPv4 by address and IPv6 by its /64', () => {
    expect(visitorKey('203.0.113.7')).toBe('203.0.113.7');
    expect(visitorKey('2001:DB8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(visitorKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('counts the methods that can change something as writes', () => {
    expect([...WRITE_METHODS].sort()).toEqual(['DELETE', 'PATCH', 'POST', 'PUT']);
  });

  it('accepts a body up to the cap, and refuses one too large or of no declared length', () => {
    const post = (headers, body = 'x') => new Request('https://example.test/', { method: 'POST', headers, body });
    expect(bodyWithinLimit(new Request('https://example.test/'))).toBe(true);
    expect(bodyWithinLimit(post({ 'content-length': String(MAX_BODY_BYTES) }))).toBe(true);
    expect(bodyWithinLimit(post({ 'content-length': String(MAX_BODY_BYTES + 1) }))).toBe(false);
    expect(bodyWithinLimit(post({}))).toBe(false);
  });

  it('tells the app a stable pseudonym in the documentation range, never the address', async () => {
    const a = await visitorPseudonym('203.0.113.7', 'k1');
    expect(a).toMatch(/^2001:db8:([0-9a-f]{1,4}:){5}[0-9a-f]{1,4}$/);
    expect(a).not.toContain('203.0.113.7');
    expect(await visitorPseudonym('203.0.113.7', 'k1')).toBe(a);
    expect(await visitorPseudonym('203.0.113.7', 'k2')).not.toBe(a);
  });
});

describe('the analytics beacon', () => {
  const appPolicy = "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";

  it("adds the beacon's script host to the app's script-src, once", () => {
    const amended = withAnalyticsScript(appPolicy);
    expect(amended).toContain(`script-src 'self' 'unsafe-inline' ${CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN}`);
    expect(amended).toContain("connect-src 'self'");
    expect(withAnalyticsScript(amended)).toBe(amended);
  });

  it('prefers script-src-elem, and falls back to a script-src made from default-src', () => {
    expect(withAnalyticsScript("script-src 'self'; script-src-elem 'self'")).toBe(
      `script-src 'self'; script-src-elem 'self' ${CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN}`,
    );
    expect(withAnalyticsScript("default-src 'self' data:")).toBe(
      `default-src 'self' data:; script-src 'self' data: ${CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN}`,
    );
  });

  it('leaves a response without a policy alone', () => {
    expect(withAnalyticsScript(null)).toBeNull();
  });
});
