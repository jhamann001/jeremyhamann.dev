type AuthRedirectInput = {
  url: string;
  baseUrl: string;
};

/**
 * Resolve an Auth.js callback target without trusting hostname prefixes.
 *
 * URL strings such as `https://app.example.attacker.tld` start with the real
 * application URL but are not same-origin. Parsing both values before comparing
 * their origins closes that lookalike-host redirect path and also rejects
 * protocol-relative, credential-host, non-HTTP, and malformed destinations.
 */
export function safeAuthRedirect({ url, baseUrl }: AuthRedirectInput): string {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return baseUrl;

    const destination = new URL(url, base);
    if (destination.origin !== base.origin) return baseUrl;
    if (destination.protocol !== "https:" && destination.protocol !== "http:") return baseUrl;

    return destination.toString();
  } catch {
    return baseUrl;
  }
}
