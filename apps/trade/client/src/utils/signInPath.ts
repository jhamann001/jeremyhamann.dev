// Where a visitor goes around signing in: back to the address they opened (a request link from another demo, say),
// as the other demos do. Shared by the sign-in page and the API client, which sends a request without a session to
// the sign-in page.

// A stand-in origin to resolve against: a value that resolves anywhere else would leave the site.
const SAME_SITE = 'https://same-site.invalid';

/**
 * A path on this site, never the sign-in page itself, or null. The value is resolved as the browser would resolve it
 * and must stay on this origin; it comes back normalized. Control characters and backslashes are refused first:
 * browsers drop tabs and newlines from a URL and read "\" as "/", so "/\t/evil.example" would become a link to
 * another site.
 */
function sitePath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, SAME_SITE);
  } catch {
    return null;
  }
  if (url.origin !== SAME_SITE || url.pathname === '/login') return null;
  // Normalizing can itself make "//": "/.//evil.example" resolves to the path "//evil.example", which a browser
  // would read as another site. Refuse it rather than repair it.
  const path = url.pathname + url.search + url.hash;
  return path.startsWith('//') ? null : path;
}

/**
 * Where a persona lands after signing in: the address they opened (a request link from another demo, say), as the
 * other demos do. On the sign-in page itself, the address the app sent them from (`/login?next=…`, set by the API
 * client when a request needs a session). Only a path on this site; otherwise home.
 */
export function signInReturnPath(location: Pick<Location, 'pathname' | 'search'> = window.location): string {
  const pathname = location.pathname ?? '';
  if (pathname === '/login') return sitePath(new URLSearchParams(location.search ?? '').get('next')) ?? '/';
  return sitePath(pathname + (location.search ?? '')) ?? '/';
}

/** The sign-in page's address for a visitor whose request needed a session: it keeps where they were. */
export function signInUrlFor(location: Pick<Location, 'pathname' | 'search'>): string {
  const here = sitePath((location.pathname ?? '') + (location.search ?? ''));
  return here && here !== '/' ? `/login?next=${encodeURIComponent(here)}` : '/login';
}
