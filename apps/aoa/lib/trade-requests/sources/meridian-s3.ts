/**
 * Shared S3 plumbing for the Meridian feeds (templates, active_accounts,
 * transitions). All three land in ONE bucket prefix as dated, feed-prefixed
 * files — e.g. `Accounts-and-associations/templates_20260601.json`. That's why
 * file selection must be FEED-AWARE: a plain `.endsWith('.json')` filter in a
 * shared prefix would let `transitions_*` outsort `templates_*` and load the
 * wrong feed.
 *
 * `S3ClientLike` is a minimal seam so unit tests inject a fake without the AWS
 * SDK. Credentials come from the default AWS provider chain (AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY); region from MERIDIAN_SNAPSHOT_S3_REGION or AWS_REGION.
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

export type FeedName = 'templates' | 'active_accounts' | 'transitions';

export interface S3ClientLike {
  listKeys(bucket: string, prefix: string): Promise<string[]>;
  download(bucket: string, key: string): Promise<{ body: string; lastModified?: string }>;
}

function createDefaultS3Client(): S3ClientLike {
  const region = process.env.MERIDIAN_SNAPSHOT_S3_REGION ?? process.env.AWS_REGION;
  const client = new S3Client(region ? { region } : {});
  return {
    async listKeys(bucket: string, prefix: string): Promise<string[]> {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      // Paginate so a bucket with >1000 objects is never silently truncated.
      do {
        const out = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
        );
        for (const obj of out.Contents ?? []) {
          if (obj.Key) keys.push(obj.Key);
        }
        continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
    async download(bucket: string, key: string): Promise<{ body: string; lastModified?: string }> {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = out.Body as { transformToString?: () => Promise<string> } | undefined;
      if (!body?.transformToString) {
        throw new Error(`S3 GetObject for ${key} returned no readable body`);
      }
      return { body: await body.transformToString(), lastModified: out.LastModified?.toISOString() };
    },
  };
}

let s3ClientFactory: () => S3ClientLike = createDefaultS3Client;

export function getS3Client(): S3ClientLike {
  return s3ClientFactory();
}

/** Test seam — inject a fake S3 client; pass null to restore the real one. */
export function _setS3ClientFactoryForTests(factory: (() => S3ClientLike) | null): void {
  s3ClientFactory = factory === null ? createDefaultS3Client : factory;
}

export interface FeedFile {
  key: string;
  /** ISO timestamp derived from the YYYYMMDD in the filename (authoritative as-of). */
  asOf: string;
}

// Static date matcher for `..._YYYYMMDD.json`. Kept as a module constant — we do
// NOT build a RegExp from the `feed` variable (avoids dynamic-regex SAST risk);
// the feed is matched by plain string prefix instead.
const FEED_DATE_RE = /_(\d{4})(\d{2})(\d{2})\.json$/;

/**
 * From a list of S3 keys, pick the newest `<feed>_YYYYMMDD.json`. Feed-aware so a
 * shared prefix holding templates_/active_accounts_/transitions_ never crosses
 * feeds. Returns null when no file for the feed is present.
 */
export function pickNewestFeedFile(keys: readonly string[], feed: FeedName): FeedFile | null {
  const filePrefix = `${feed}_`;
  let best: { key: string; ymd: string; asOf: string } | null = null;
  for (const key of keys) {
    const base = key.slice(key.lastIndexOf('/') + 1); // basename
    if (!base.startsWith(filePrefix)) continue; // feed match by string, not a built regex
    const m = base.match(FEED_DATE_RE);
    if (!m) continue;
    const [, y, mo, d] = m;
    const month = Number(mo);
    const day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const ymd = `${y}${mo}${d}`;
    if (!best || ymd > best.ymd) {
      best = { key, ymd, asOf: `${y}-${mo}-${d}T00:00:00.000Z` };
    }
  }
  return best ? { key: best.key, asOf: best.asOf } : null;
}
