import { describe, expect, it } from 'vitest';
import { signInReturnPath, signInUrlFor } from '../signInPath';

describe('where a visitor goes around signing in', () => {
  it('sends a request without a session to the sign-in page, keeping where the visitor was', () => {
    expect(signInUrlFor({ pathname: '/queue/REQ-00001045', search: '' })).toBe('/login?next=%2Fqueue%2FREQ-00001045');
    expect(signInUrlFor({ pathname: '/queue', search: '?status=open' })).toBe('/login?next=%2Fqueue%3Fstatus%3Dopen');
    expect(signInUrlFor({ pathname: '/', search: '' })).toBe('/login');
  });

  it('returns from the sign-in page to that address', () => {
    expect(signInReturnPath({ pathname: '/login', search: '?next=%2Fqueue%2FREQ-00001045' })).toBe('/queue/REQ-00001045');
    expect(signInReturnPath({ pathname: '/login', search: '' })).toBe('/');
  });

  it('returns to the address opened when the sign-in page shows there', () => {
    expect(signInReturnPath({ pathname: '/queue/REQ-00001045', search: '?x=1' })).toBe('/queue/REQ-00001045?x=1');
  });

  it('never leaves the site, and never returns to the sign-in page', () => {
    for (const next of [
      'https://evil.example/x', '//evil.example/x', '/\\evil.example', '/login', '/login?next=%2F', 'queue',
      // Browsers drop tabs and newlines inside a URL, so these would turn into "//evil.example".
      '/\t/evil.example', '/\n/evil.example', '/\r\n/evil.example', '/\u0000/evil.example',
      // Dot segments that normalize into "//evil.example".
      '/.//evil.example', '/%2e//evil.example', '/x/..//evil.example',
    ]) {
      expect(signInReturnPath({ pathname: '/login', search: `?next=${encodeURIComponent(next)}` }), next).toBe('/');
    }
    expect(signInReturnPath({ pathname: '//evil.example/x', search: '' })).toBe('/');
    expect(signInUrlFor({ pathname: '//evil.example/x', search: '' })).toBe('/login');
  });

  it('keeps an encoded character as a harmless path, and returns the address normalized', () => {
    expect(signInReturnPath({ pathname: '/login', search: `?next=${encodeURIComponent('/%09/evil.example')}` })).toBe('/%09/evil.example');
    expect(signInReturnPath({ pathname: '/login', search: `?next=${encodeURIComponent('/queue/../queue/REQ-1#top')}` })).toBe('/queue/REQ-1#top');
  });
});
