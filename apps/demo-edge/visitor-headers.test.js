import { describe, expect, it } from 'vitest';
import { forwardableHeaders } from './visitor-headers.js';

describe('the headers a demo forwards to its app', () => {
  it("drops the visitor's address, location and routing headers, and keeps the rest", () => {
    const headers = forwardableHeaders(
      new Headers({
        'cf-connecting-ip': '198.51.100.1',
        'cf-connecting-ipv6': '2001:db8::1',
        'cf-ipcountry': 'US',
        'cf-ipcity': 'Springfield',
        'cf-ray': '8f0000000000-IAD',
        'cf-container-target-port': '9000',
        'true-client-ip': '198.51.100.1',
        'x-real-ip': '198.51.100.1',
        forwarded: 'for=198.51.100.1',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-port': '9000',
        cookie: 'session=v1.a.b',
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
      }),
    );
    expect([...headers.keys()].sort()).toEqual(['content-type', 'cookie', 'sec-fetch-site']);
  });

  it('keeps every value of a repeated header', () => {
    const repeated = new Headers();
    repeated.append('accept', 'text/html');
    repeated.append('accept', 'application/json');
    expect(forwardableHeaders(repeated).get('accept')).toBe('text/html, application/json');
  });
});
