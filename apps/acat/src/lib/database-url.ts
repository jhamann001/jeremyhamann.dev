// Neon pauses an idle compute (scale to zero; the free plan can't turn it off) and needs a few
// seconds to wake it. Prisma's default connect timeout is 5 s and can run out first, which fails the
// first query after a quiet spell with P1001 "Can't reach database server". Neon's Prisma guide
// recommends connect_timeout=15, so every connection string gets it unless it sets its own.

export const CONNECT_TIMEOUT_SECONDS = "15";

export function withConnectTimeout(url: string | undefined = process.env.DATABASE_URL): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("connect_timeout")) parsed.searchParams.set("connect_timeout", CONNECT_TIMEOUT_SECONDS);
    return parsed.toString();
  } catch {
    return url;
  }
}
