import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cookieTheme, scriptPlacement, THEME_COOKIE, themeRedirect, themeScript, withTheme } from './theme-handoff.js';

const hashOf = (script) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`;

describe('the theme hand-off from the portfolio site', () => {
  it('moves ?theme= into a short-lived cookie and redirects to the clean address', () => {
    const response = themeRedirect(new Request('https://helpdesk.example/?theme=dark&x=1'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://helpdesk.example/?x=1');
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toContain(`${THEME_COOKIE}=dark;`);
    expect(cookie).toMatch(/Max-Age=300/);
    expect(cookie).toMatch(/HttpOnly/);
  });

  it('sets the app\'s own theme cookie instead, for an app whose server reads one (the advisor platform)', () => {
    const response = themeRedirect(new Request('https://advisor.example/sign-in?theme=light'), { cookie: 'theme' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://advisor.example/sign-in');
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toBe('theme=light; Path=/; Max-Age=31536000; Secure; SameSite=Lax');
    // Not HttpOnly: the app's own toggle rewrites it from the page.
    expect(cookie).not.toMatch(/HttpOnly/);
    expect(cookie).not.toContain(THEME_COOKIE);
  });

  it('ignores other values, other methods and addresses without the parameter', () => {
    expect(themeRedirect(new Request('https://helpdesk.example/?theme=blue'))).toBeNull();
    expect(themeRedirect(new Request('https://helpdesk.example/'))).toBeNull();
    expect(themeRedirect(new Request('https://helpdesk.example/?theme=dark', { method: 'POST', body: 'x' }))).toBeNull();
  });

  it('reads the cookie among others, and nothing else', () => {
    const withCookie = (cookie) => new Request('https://helpdesk.example/', { headers: { cookie } });
    expect(cookieTheme(withCookie('a=1; demo_theme=light; b=2'))).toBe('light');
    expect(cookieTheme(withCookie('demo_theme=dark'))).toBe('dark');
    expect(cookieTheme(withCookie('demo_theme=purple'))).toBeNull();
    expect(cookieTheme(withCookie('xdemo_theme=dark'))).toBeNull();
    expect(cookieTheme(new Request('https://helpdesk.example/'))).toBeNull();
  });

  it('writes the app\'s own storage key, and paints the dark class only for an app that asks', () => {
    expect(themeScript('dark', { storageKey: 'theme' })).toBe('try{localStorage.setItem("theme","dark")}catch(e){}');
    expect(themeScript('light', { storageKey: 'theme-preference', darkClass: true })).toBe(
      'try{localStorage.setItem("theme-preference","light");document.documentElement.classList.toggle("dark",false)}catch(e){}',
    );
  });
});

describe('placing the line under each demo\'s Content-Security-Policy', () => {
  const script = themeScript('dark', { storageKey: 'theme' });

  it('carries the page\'s nonce (the Transfer Tracker)', async () => {
    const csp = "default-src 'self'; script-src 'self' 'nonce-abc123' 'strict-dynamic'; object-src 'none'";
    expect(await scriptPlacement(csp, script)).toEqual({ nonce: 'abc123' });
  });

  it('runs as it is under unsafe-inline, leaving the policy alone (the help desk)', async () => {
    const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com";
    expect(await scriptPlacement(csp, script)).toEqual({});
  });

  it('adds its hash where only the app\'s own files may run (Trade Request)', async () => {
    const csp = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; script-src-attr 'none'";
    const { csp: widened } = await scriptPlacement(csp, script);
    expect(widened).toBe(
      `default-src 'self'; script-src 'self' https://static.cloudflareinsights.com ${hashOf(script)}; script-src-attr 'none'`,
    );
  });

  it('adds the hash, not reliance on unsafe-inline, when the policy already pins hashes', async () => {
    const csp = "script-src 'self' 'unsafe-inline' 'sha256-AAAA'";
    expect((await scriptPlacement(csp, script)).csp).toContain(hashOf(script));
  });

  it('prefers script-src-elem, and falls back to default-src through a new script-src', async () => {
    const elem = await scriptPlacement("script-src 'self' 'nonce-x'; script-src-elem 'self'", script);
    expect(elem.csp).toBe(`script-src 'self' 'nonce-x'; script-src-elem 'self' ${hashOf(script)}`);
    const fallback = await scriptPlacement("default-src 'self'; img-src 'self'", script);
    expect(fallback.csp).toBe(`default-src 'self'; img-src 'self'; script-src 'self' ${hashOf(script)}`);
  });

  it('needs nothing without a policy or a script directive', async () => {
    expect(await scriptPlacement(null, script)).toEqual({});
    expect(await scriptPlacement("img-src 'self'", script)).toEqual({});
  });
});

describe('a page with the theme applied', () => {
  it('passes anything that is not an HTML page through untouched', async () => {
    const json = new Response('{}', { headers: { 'content-type': 'application/json' } });
    expect(await withTheme(json, 'dark', { storageKey: 'theme' })).toBe(json);
  });

  it('falls back to the page as it was if the rewrite cannot run', async () => {
    // HTMLRewriter exists only in the Workers runtime; in Node its absence stands in for any failure.
    const page = new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } });
    expect(await withTheme(page, 'dark', { storageKey: 'theme' })).toBe(page);
  });
});
