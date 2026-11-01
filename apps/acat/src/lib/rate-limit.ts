interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const store = new Map<string, TokenBucket>();
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

interface RateLimitOptions {
  maxTokens?: number;
  refillRate?: number;
  interval?: number;
}

export function rateLimit(
  key: string,
  options: RateLimitOptions = {}
): { allowed: boolean; remaining: number } {
  const { maxTokens = 60, refillRate = 60, interval = 60_000 } = options;

  if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
    const cutoff = Date.now() - interval * 2;
    for (const [k, bucket] of store) {
      if (bucket.lastRefill < cutoff) store.delete(k);
    }
    lastCleanup = Date.now();
  }

  const now = Date.now();
  let bucket = store.get(key);

  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    store.set(key, bucket);
  }

  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor((elapsed / interval) * refillRate);
  if (refill > 0) {
    bucket.tokens = Math.min(maxTokens, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  if (bucket.tokens > 0) {
    bucket.tokens--;
    return { allowed: true, remaining: bucket.tokens };
  }

  return { allowed: false, remaining: 0 };
}
