// Serves the static site. Sends http and www to https on the root domain, adds security headers,
// and lets search engines in only while SITE_INDEXABLE is "true".

// static.cloudflareinsights.com: Cloudflare Web Analytics beacon, injected by Cloudflare's edge.
// It reports back to this origin (/cdn-cgi/rum), which connect-src 'self' already covers.
// The demo hosts in connect-src: the pages wake a demo's container ahead of a visit (src/layouts/Base.astro).
const DEMO_ORIGINS = [
  'https://trade.jeremyhamann.dev',
  'https://transfers.jeremyhamann.dev',
  'https://helpdesk.jeremyhamann.dev',
  'https://statements.jeremyhamann.dev',
  'https://aoa.jeremyhamann.dev',
];
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
    `font-src 'self'; connect-src 'self' ${DEMO_ORIGINS.join(' ')}; frame-ancestors 'none'; base-uri 'self'; ` +
    "form-action 'self'",
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' || url.hostname.startsWith('www.')) {
      url.protocol = 'https:';
      if (url.hostname.startsWith('www.')) url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/robots.txt') {
      const body =
        env.SITE_INDEXABLE === 'true'
          ? `User-agent: *\nAllow: /\n\nSitemap: ${url.origin}/sitemap.xml\n`
          : 'User-agent: *\nDisallow: /\n';
      return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
    }

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    if (env.SITE_INDEXABLE !== 'true') headers.set('X-Robots-Tag', 'noindex, nofollow');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
