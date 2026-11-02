// Starts each demo in the theme the visitor was reading the portfolio site in. The site links every demo with
// ?theme=light or ?theme=dark. A demo's Worker moves that into a short-lived cookie and redirects to the clean
// address, because the app's own redirects (/ to /sign-in, say) would drop the parameter. On the first HTML
// page after that, the Worker puts one line at the top of <head> that saves the theme where the app's own
// theme code looks for it, so the page paints in that theme, and clears the cookie.
// An app whose server reads the theme from a cookie of its own (config `{ cookie }`) needs no line: the redirect
// sets that cookie, as the app's own toggle would, and the next page is rendered in the theme.
//
// Shared by the demo Workers (apps/*/worker); its tests run with the help desk Worker's.

export const THEME_COOKIE = 'demo_theme';
const THEMES = new Set(['light', 'dark']);

/**
 * For a GET carrying ?theme=light|dark: a redirect to the same address without it, setting the cookie (the app's
 * own, readable by its toggle, when `config.cookie` names one).
 */
export function themeRedirect(request, config = {}) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  const theme = url.searchParams.get('theme');
  if (!THEMES.has(theme)) return null;
  url.searchParams.delete('theme');
  const cookie = config.cookie
    ? `${config.cookie}=${theme}; Path=/; Max-Age=31536000; Secure; SameSite=Lax`
    : `${THEME_COOKIE}=${theme}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`;
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), 'set-cookie': cookie, 'cache-control': 'no-store' },
  });
}

/** The theme the request's cookie carries, or null. */
export function cookieTheme(request) {
  const match = /(?:^|;\s*)demo_theme=(light|dark)(?:;|$)/.exec(request.headers.get('cookie') ?? '');
  return match ? match[1] : null;
}

/**
 * The line that saves the theme: in `storageKey`, which the app's theme code reads before it paints, and, for
 * an app that only applies its theme once its scripts run, as the `dark` class on <html> straight away.
 */
export function themeScript(theme, { storageKey, darkClass = false }) {
  const save = `localStorage.setItem(${JSON.stringify(storageKey)},${JSON.stringify(theme)})`;
  const paint = darkClass ? `;document.documentElement.classList.toggle("dark",${theme === 'dark'})` : '';
  return `try{${save}${paint}}catch(e){}`;
}

async function sha256Base64(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest));
}

/**
 * How the line may run under the page's Content-Security-Policy. The directive that governs a <script> is
 * script-src-elem, else script-src, else default-src.
 *   - a nonce there: the line carries it;
 *   - 'unsafe-inline' with no hash or nonce: the line runs as it is. Adding a hash here would switch
 *     'unsafe-inline' off for the app's own inline scripts, so the policy is left alone;
 *   - otherwise: the line's hash is added to that directive.
 * Returns { nonce?, csp? }: `csp` is the policy to send when it had to change.
 */
export async function scriptPlacement(csp, script) {
  if (!csp) return {};
  const directives = csp.split(';').map((d) => d.trim()).filter(Boolean);
  const named = (name) => directives.findIndex((d) => d.toLowerCase().split(/\s+/)[0] === name);
  const index = [named('script-src-elem'), named('script-src'), named('default-src')].find((i) => i !== -1);
  if (index === undefined) return {};
  const [name, ...sources] = directives[index].split(/\s+/);
  const nonce = sources.map((s) => /^'nonce-([^']+)'$/.exec(s)?.[1]).find(Boolean);
  if (nonce) return { nonce };
  const pinned = sources.some((s) => /^'(sha256|sha384|sha512)-/.test(s));
  if (sources.includes("'unsafe-inline'") && !pinned) return {};
  const hash = `'sha256-${await sha256Base64(script)}'`;
  // default-src governs scripts only when nothing more specific does, so the hash goes in a new script-src.
  if (name.toLowerCase() === 'default-src') directives.push(`script-src ${sources.join(' ')} ${hash}`);
  else directives[index] = `${directives[index]} ${hash}`;
  return { csp: directives.join('; ') };
}

/**
 * The response with the theme line at the top of <head>, the cookie cleared and, if needed, the policy
 * widened by the line's hash. Anything that isn't an HTML page, and any failure, passes through unchanged:
 * the worst case is a demo in its default theme.
 */
export async function withTheme(response, theme, config) {
  if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response;
  try {
    const script = themeScript(theme, config);
    const placement = await scriptPlacement(response.headers.get('content-security-policy'), script);
    const headers = new Headers(response.headers);
    if (placement.csp) headers.set('content-security-policy', placement.csp);
    headers.append('set-cookie', `${THEME_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    const tag = `<script${placement.nonce ? ` nonce="${placement.nonce}"` : ''}>${script}</script>`;
    const page = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    return new HTMLRewriter()
      .on('head', {
        element(head) {
          head.prepend(tag, { html: true });
        },
      })
      .transform(page);
  } catch {
    return response;
  }
}
