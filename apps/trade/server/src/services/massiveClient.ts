/**
 * Minimal Massive (Polygon-style) REST client for the security-sector backfill.
 * Isolated on purpose — the only thing the app uses Massive for is the one-time
 * ticker-reference (SIC) lookup in the backfill script. The nightly drift run
 * never calls this; it reads the cached `security_sector` table.
 *
 * Auth: defaults to `Authorization: Bearer <key>` (Polygon supports this). If
 * the account needs the query-param scheme instead, set MASSIVE_AUTH=query and
 * it sends `?apiKey=<key>`. Base URL overridable via MASSIVE_BASE_URL.
 *
 * Env: MASSIVE_API_KEY (required to run), MASSIVE_BASE_URL, MASSIVE_AUTH.
 */

export class MassiveRateLimitError extends Error {
  constructor(message = 'Massive rate limit (HTTP 429)') {
    super(message);
    this.name = 'MassiveRateLimitError';
  }
}

export interface TickerReference {
  ticker: string;
  name: string | null;
  sicCode: string | null;
  sicDescription: string | null;
}

export function isMassiveConfigured(): boolean {
  return !!process.env.MASSIVE_API_KEY;
}

function baseUrl(): string {
  return (process.env.MASSIVE_BASE_URL ?? 'https://api.massive.com').replace(/\/+$/, '');
}

/**
 * Fetch a single ticker's reference data. Returns:
 *   - the reference (with sic fields) on success,
 *   - `null` when the ticker is not found (404) — caller records an unresolved attempt,
 *   - throws `MassiveRateLimitError` on 429 (caller backs off + retries),
 *   - throws on other non-OK statuses.
 */
export async function fetchTickerReference(ticker: string): Promise<TickerReference | null> {
  const key = process.env.MASSIVE_API_KEY ?? '';
  if (!key) throw new Error('MASSIVE_API_KEY is not set');

  const useQueryAuth = (process.env.MASSIVE_AUTH ?? 'bearer').toLowerCase() === 'query';
  const suffix = useQueryAuth ? `?apiKey=${encodeURIComponent(key)}` : '';
  const url = `${baseUrl()}/v3/reference/tickers/${encodeURIComponent(ticker)}${suffix}`;
  const headers: Record<string, string> = useQueryAuth ? {} : { Authorization: `Bearer ${key}` };

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429) throw new MassiveRateLimitError();
  if (res.status === 404) return null;
  if (!res.ok) {
    await res.text().catch(() => '');
    throw new Error(`Massive ticker reference for ${ticker} returned ${res.status}`);
  }

  const json = (await res.json()) as {
    results?: { ticker?: string; name?: string; sic_code?: string | number; sic_description?: string };
  };
  const r = json.results;
  if (!r) return null;
  return {
    ticker: r.ticker ?? ticker,
    name: r.name ?? null,
    sicCode: r.sic_code != null && r.sic_code !== '' ? String(r.sic_code) : null,
    sicDescription: r.sic_description ?? null,
  };
}
