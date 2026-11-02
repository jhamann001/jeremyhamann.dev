/**
 * Loader for the Meridian transitions feed (`transitions_YYYYMMDD.json` in the
 * shared S3 prefix). A "transition" is the one-time move of a transferred-in
 * book toward the account's model, executed in tranches under an annual
 * realized-gain budget. The feed is the PLAN side (estimated tax, target,
 * constraints) — it has no execution signal yet (see docs), so we use it to
 * CONFIRM that an account is being transitioned and surface the estimate, not as
 * a record of trades.
 *
 * S3-only (no GCS equivalent). Reads the newest file, dedups to the LATEST
 * transition per account (by updated_timestamp) since advisors iterate many
 * drafts per account. `external_account_no` is a full 26-char ULID — the same
 * key the comparator joins on — so the runner uses the map directly.
 */
import logger from '@/lib/trade-requests/log';
import { getS3Client, pickNewestFeedFile } from '@/lib/trade-requests/sources/meridian-s3';

export interface TransitionSummary {
  /** Full 26-char account ULID from the feed's `external_account_no`. */
  externalAccountNo: string;
  title: string | null;
  targetName: string | null;
  targetType: string | null;
  /** Estimated realized gain to fully transition (source_pnl.net_pnl). */
  estNetRealizedGainUsd: number | null;
  estShortTermGainUsd: number | null;
  estLongTermGainUsd: number | null;
  /** ISO updated_timestamp of the latest transition for this account. */
  updatedAt: string | null;
  state: string | null;
  runtimeStatus: string | null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

interface RawTransition {
  external_account_no?: string | null;
  title?: string | null;
  state?: string | null;
  runtime_status?: string | null;
  updated_timestamp?: string | null;
  req_body?: {
    target_portfolio_name?: string | null;
    target_portfolio_type?: string | null;
    source_pnl?: { net_pnl?: unknown; st_gains?: unknown; lt_gains?: unknown } | null;
  } | null;
}

function toSummary(t: RawTransition): TransitionSummary {
  const sp = t.req_body?.source_pnl ?? {};
  return {
    externalAccountNo: t.external_account_no ?? '',
    title: t.title ?? null,
    targetName: t.req_body?.target_portfolio_name ?? null,
    targetType: t.req_body?.target_portfolio_type ?? null,
    estNetRealizedGainUsd: num(sp.net_pnl),
    estShortTermGainUsd: num(sp.st_gains),
    estLongTermGainUsd: num(sp.lt_gains),
    updatedAt: t.updated_timestamp ?? null,
    state: t.state ?? null,
    runtimeStatus: t.runtime_status ?? null,
  };
}

/**
 * Load the latest transition per account from S3, keyed by the feed's full
 * account ULID (`external_account_no`). Returns an empty map when the S3 source isn't configured
 * (e.g. running on the GCS source) — transitions are an S3-only enhancement.
 */
export async function loadMeridianTransitions(): Promise<Map<string, TransitionSummary>> {
  const out = new Map<string, TransitionSummary>();
  const bucket = process.env.MERIDIAN_SNAPSHOT_S3_BUCKET;
  if ((process.env.MERIDIAN_SNAPSHOT_SOURCE ?? 'gcs') !== 's3' || !bucket) {
    return out; // transitions only ship on the S3 feed
  }
  const rawPrefix = process.env.MERIDIAN_SNAPSHOT_S3_PREFIX ?? 'Accounts-and-associations/';
  const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;

  const client = getS3Client();
  const keys = await client.listKeys(bucket, prefix);
  const newest = pickNewestFeedFile(keys, 'transitions');
  if (!newest) {
    logger.info({ event: 'transitions_none', prefix }, 'no transitions_YYYYMMDD.json found — skipping');
    return out;
  }

  const { body } = await client.download(bucket, newest.key);
  const parsed = JSON.parse(body) as { transitions?: RawTransition[] };
  const transitions = Array.isArray(parsed.transitions) ? parsed.transitions : [];

  // Dedup to the latest transition per account by updated_timestamp (advisors
  // iterate many drafts; the most-recently-updated one is the current plan).
  for (const t of transitions) {
    const acct = t.external_account_no;
    if (!acct) continue;
    const prev = out.get(acct);
    if (!prev || (t.updated_timestamp ?? '') > (prev.updatedAt ?? '')) {
      out.set(acct, toSummary(t));
    }
  }

  logger.info(
    { event: 'transitions_loaded', file: newest.key, rawTransitions: transitions.length, distinctAccounts: out.size },
    'meridian transitions loaded',
  );
  return out;
}
