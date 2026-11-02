import { promises as fs } from 'node:fs';
import { Storage } from '@google-cloud/storage';
import { z } from 'zod';
import logger from '@/lib/trade-requests/log';
import { type HouseholdConfig, type HouseholdEntry, HouseholdConfigError } from '@/lib/trade-requests/sources/household-config';
import { STALE_SNAPSHOT_THRESHOLD_DAYS, deriveAsOfFromFilename } from '@/lib/trade-requests/sources/meridian-snapshot';
import { getS3Client, pickNewestFeedFile } from '@/lib/trade-requests/sources/meridian-s3';

/**
 * GCS loader for the Meridian `active_accounts.json` export — the runtime
 * source of truth for the firm's account roster, household mapping, account
 * titles, and `account_type` metadata.
 *
 * GCS path: `gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/active_accounts/<YYYY-MM-DD>.json`
 * Latest-by-filename selection mirrors the templates loader pattern. The
 * shared `STALE_SNAPSHOT_THRESHOLD_DAYS` (35) gates "snapshot too old"
 * rejection so both files stay in lockstep with the same staleness contract.
 *
 * Wire shape (per `<local path>`):
 *
 * {
 *   "generated_at": "...",
 *   "firm_id": "...",
 *   "account_count": 97,
 *   "raw_row_count": 423,
 *   "accounts": [
 *     {
 *       "account_id": 27216,
 *       "trading_account_no": "01SYNTHJ7G094TRY2A6R126CB3",
 *       "account_title": "Abdul Kuhlman - Brokerage",
 *       "account_type": "NA",
 *       "cash": 0.29, "equity": 0.0, "total": 0.29,
 *       "household_id": 3027,
 *       "household_name": "Kuhlman + Borer Family",
 *       "sleeves": [],
 *       "associations": [...]
 *     },
 *     ...
 *   ]
 * }
 *
 * Output: `ActiveAccountsPayload` (full per-account shape) + a helper
 * `toHouseholdConfig` that converts the payload into the same `HouseholdConfig`
 * shape the v1 and v2 comparators have consumed since ticket — so the runner
 * cutover is a one-line swap, not a downstream rewrite.
 */

export class ActiveAccountsLoadError extends Error {
  public readonly status = 503;
  public readonly source: string;
  constructor(message: string, source: string) {
    super(message);
    this.name = 'ActiveAccountsLoadError';
    this.source = source;
  }
}

// A full 26-char ULID — the account key the comparator joins on. Both the S3
// and GCS Meridian feeds now emit full ULIDs (the S3 feed previously masked
// to last-4, which we resolved downstream; that masking is retired). A masked
// value here now fails validation loudly rather than silently going unmapped.
const ULID_RE = /^[0-9A-Z]{26}$/;

const ActiveAccountRowSchema = z
  .object({
    account_id: z.union([z.number(), z.string()]).optional(),
    trading_account_no: z.string().refine((v) => ULID_RE.test(v), 'trading_account_no must be a 26-char ULID'),
    account_title: z
      .string()
      .min(1)
      .refine((v) => v.trim().length > 0, 'account_title must be non-blank'),
    account_type: z.string().optional(),
    cash: z.number().finite().optional(),
    equity: z.number().finite().optional(),
    total: z.number().finite().optional(),
    // Nullable: a freshly-opened account can land in the feed before it has been
    // assigned to a household (the firm households new accounts the next morning).
    // We must NOT fail the whole feed over this — `buildPayload` drops these
    // unlinked rows with a logged warning so the nightly drift run still proceeds
    // for every linked account. A non-null value still has to be valid.
    household_id: z.number().int().positive().nullable(),
    household_name: z
      .string()
      .min(1)
      .refine((v) => v.trim().length > 0, 'household_name must be non-blank')
      .nullable(),
    sleeves: z.array(z.unknown()).optional(),
    associations: z.array(z.unknown()).optional(),
  })
  .passthrough();

const ActiveAccountsPayloadSchema = z
  .object({
    generated_at: z.string().optional(),
    firm_id: z.union([z.string(), z.number()]).optional(),
    account_count: z.number().int().nonnegative().optional(),
    raw_row_count: z.number().int().nonnegative().optional(),
    accounts: z.array(ActiveAccountRowSchema).min(1, 'active_accounts payload must contain ≥1 account'),
  })
  .passthrough();

type ActiveAccountRow = z.infer<typeof ActiveAccountRowSchema>;

export interface ActiveAccountEntry {
  accountId: number | string | undefined;
  tradingAccountNo: string;
  accountTitle: string;
  accountType: string | undefined;
  cash: number | undefined;
  equity: number | undefined;
  total: number | undefined;
  householdId: number;
  householdName: string;
}

export interface ActiveAccountsPayload {
  generatedAt: string;
  firmId: string | number | undefined;
  accountCount: number | undefined;
  rawRowCount: number | undefined;
  accounts: readonly ActiveAccountEntry[];
}

interface GcsFileMetadataLike {
  updated?: string;
}

interface GcsFileLike {
  name: string;
  download(): Promise<[Buffer]>;
  getMetadata?: () => Promise<[GcsFileMetadataLike]>;
}

interface GcsBucketLike {
  getFiles(opts: { prefix: string }): Promise<[GcsFileLike[]]>;
}

interface GcsStorageLike {
  bucket(name: string): GcsBucketLike;
}

let storageFactory: () => GcsStorageLike = () => new Storage() as unknown as GcsStorageLike;

export function _setStorageFactoryForTests(factory: (() => GcsStorageLike) | null): void {
  if (factory === null) {
    storageFactory = () => new Storage() as unknown as GcsStorageLike;
    return;
  }
  storageFactory = factory;
}

const STALE_SNAPSHOT_THRESHOLD_MS = STALE_SNAPSHOT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

function rowToEntry(row: ActiveAccountRow, householdId: number, householdName: string): ActiveAccountEntry {
  return {
    accountId: row.account_id,
    tradingAccountNo: row.trading_account_no,
    accountTitle: row.account_title,
    accountType: row.account_type,
    cash: row.cash,
    equity: row.equity,
    total: row.total,
    householdId,
    householdName,
  };
}

function parsePayloadOrThrow(raw: string, sourceLabel: string): z.infer<typeof ActiveAccountsPayloadSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ActiveAccountsLoadError(
      `Active accounts file ${sourceLabel} is not valid JSON: ${(err as Error).message}`,
      sourceForLabel(sourceLabel),
    );
  }
  const result = ActiveAccountsPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new ActiveAccountsLoadError(
      `Active accounts file ${sourceLabel} failed schema validation: ${result.error.message}`,
      sourceForLabel(sourceLabel),
    );
  }
  return result.data;
}

function sourceForLabel(label: string): string {
  return label.startsWith('gs://') ? 'gcs' : 'file';
}

interface BuildPayloadInput {
  raw: z.infer<typeof ActiveAccountsPayloadSchema>;
  sourceLabel: string;
  asOf: string;
}

function buildPayload(input: BuildPayloadInput): ActiveAccountsPayload {
  const entries: ActiveAccountEntry[] = [];
  const seenUlid = new Set<string>();
  const unlinked: { tradingAccountNo: string; accountTitle: string }[] = [];
  for (const row of input.raw.accounts) {
    if (seenUlid.has(row.trading_account_no)) {
      throw new ActiveAccountsLoadError(
        `Active accounts file ${input.sourceLabel}: duplicate trading_account_no "${row.trading_account_no}"`,
        sourceForLabel(input.sourceLabel),
      );
    }
    seenUlid.add(row.trading_account_no);

    // New accounts can appear before the firm assigns them to a household. Drop
    // them from the comparison rather than failing the whole feed — they carry no
    // model/template anyway, so there is nothing to drift-check until they're
    // householded (typically the next morning). They re-enter normally once linked.
    const householdId = row.household_id;
    const householdName = row.household_name;
    if (householdId == null || householdName == null) {
      unlinked.push({ tradingAccountNo: row.trading_account_no, accountTitle: row.account_title });
      continue;
    }
    entries.push(rowToEntry(row, householdId, householdName));
  }

  if (unlinked.length > 0) {
    logger.warn(
      {
        event: 'active_accounts_unlinked_household',
        sourceLabel: input.sourceLabel,
        count: unlinked.length,
        accounts: unlinked,
      },
      `active_accounts: ${unlinked.length} account(s) skipped — no household assigned yet`,
    );
  }

  return {
    generatedAt: input.asOf,
    firmId: input.raw.firm_id,
    accountCount: input.raw.account_count,
    rawRowCount: input.raw.raw_row_count,
    accounts: entries,
  };
}

async function loadFromGcs(now: Date): Promise<ActiveAccountsPayload> {
  const source = 'gcs';
  const bucketName = process.env.MERIDIAN_SNAPSHOT_BUCKET;
  if (!bucketName) {
    throw new ActiveAccountsLoadError('MERIDIAN_SNAPSHOT_BUCKET is not configured', source);
  }

  const storage = storageFactory();

  let files: GcsFileLike[];
  try {
    const [allFiles] = await storage.bucket(bucketName).getFiles({ prefix: 'meridian/active_accounts/' });
    files = allFiles;
  } catch (err) {
    throw new ActiveAccountsLoadError(
      `Cannot list gs://${bucketName}/meridian/active_accounts/: ${(err as Error).message}`,
      source,
    );
  }

  const jsonFiles = files.filter((file) => file.name.endsWith('.json'));
  if (jsonFiles.length === 0) {
    throw new ActiveAccountsLoadError(
      `No active_accounts files found under gs://${bucketName}/meridian/active_accounts/`,
      source,
    );
  }

  jsonFiles.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const latest = jsonFiles[0];
  const sourceLabel = `gs://${bucketName}/${latest.name}`;

  let raw: string;
  try {
    const [buffer] = await latest.download();
    raw = buffer.toString('utf-8');
  } catch (err) {
    throw new ActiveAccountsLoadError(`Cannot download ${latest.name}: ${(err as Error).message}`, source);
  }

  const parsed = parsePayloadOrThrow(raw, sourceLabel);

  let asOf = deriveAsOfFromFilename(latest.name);
  if (!asOf && latest.getMetadata) {
    try {
      const [metadata] = await latest.getMetadata();
      if (metadata?.updated) {
        const parsedDate = new Date(metadata.updated);
        if (!Number.isNaN(parsedDate.getTime())) {
          asOf = parsedDate.toISOString();
        }
      }
    } catch (err) {
      logger.warn(
        {
          event: 'active_accounts_metadata_fetch_failed',
          source,
          file: latest.name,
          message: (err as Error).message,
        },
        'meridian active_accounts: getMetadata() failed; falling back',
      );
    }
  }
  if (!asOf) {
    throw new ActiveAccountsLoadError(
      `Active accounts file ${latest.name} has no parseable date in filename (expected YYYY-MM-DD.json) and no GCS object metadata updated time`,
      source,
    );
  }

  const ageMs = now.getTime() - new Date(asOf).getTime();
  if (ageMs > STALE_SNAPSHOT_THRESHOLD_MS) {
    throw new ActiveAccountsLoadError(
      `Active accounts file ${latest.name} (as_of ${asOf}) is older than ${STALE_SNAPSHOT_THRESHOLD_DAYS} days`,
      source,
    );
  }

  const payload = buildPayload({ raw: parsed, sourceLabel, asOf });

  logger.info(
    {
      event: 'active_accounts_loaded',
      source,
      file: latest.name,
      asOf,
      accountCount: payload.accounts.length,
      householdCount: new Set(payload.accounts.map((a) => a.householdName)).size,
    },
    'meridian active_accounts loaded',
  );

  return payload;
}

/**
 * S3 loader — reads the newest `active_accounts_YYYYMMDD.json` from the shared
 * Meridian prefix (templates / active_accounts / transitions live side by
 * side, so selection is feed-aware via `pickNewestFeedFile`). Behaviourally
 * identical to `loadFromGcs`: same staleness gate, same `ActiveAccountsPayload`.
 * Credentials from the default AWS chain; region from
 * MERIDIAN_SNAPSHOT_S3_REGION or AWS_REGION.
 */
async function loadFromS3(now: Date): Promise<ActiveAccountsPayload> {
  const source = 's3';
  const bucketName = process.env.MERIDIAN_SNAPSHOT_S3_BUCKET;
  if (!bucketName) {
    throw new ActiveAccountsLoadError('MERIDIAN_SNAPSHOT_S3_BUCKET is not configured', source);
  }
  const rawPrefix = process.env.MERIDIAN_SNAPSHOT_S3_PREFIX ?? 'Accounts-and-associations/';
  const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;

  const client = getS3Client();

  let keys: string[];
  try {
    keys = await client.listKeys(bucketName, prefix);
  } catch (err) {
    throw new ActiveAccountsLoadError(`Cannot list s3://${bucketName}/${prefix}: ${(err as Error).message}`, source);
  }

  const newest = pickNewestFeedFile(keys, 'active_accounts');
  if (!newest) {
    throw new ActiveAccountsLoadError(
      `No active_accounts_YYYYMMDD.json files found under s3://${bucketName}/${prefix}`,
      source,
    );
  }
  const sourceLabel = `s3://${bucketName}/${newest.key}`;

  let raw: string;
  try {
    const obj = await client.download(bucketName, newest.key);
    raw = obj.body;
  } catch (err) {
    throw new ActiveAccountsLoadError(`Cannot download ${newest.key}: ${(err as Error).message}`, source);
  }

  const parsed = parsePayloadOrThrow(raw, sourceLabel);
  const asOf = newest.asOf;

  const ageMs = now.getTime() - new Date(asOf).getTime();
  if (ageMs > STALE_SNAPSHOT_THRESHOLD_MS) {
    throw new ActiveAccountsLoadError(
      `Active accounts file ${newest.key} (as_of ${asOf}) is older than ${STALE_SNAPSHOT_THRESHOLD_DAYS} days`,
      source,
    );
  }

  const payload = buildPayload({ raw: parsed, sourceLabel, asOf });

  logger.info(
    {
      event: 'active_accounts_loaded',
      source,
      file: newest.key,
      asOf,
      accountCount: payload.accounts.length,
      householdCount: new Set(payload.accounts.map((a) => a.householdName)).size,
    },
    'meridian active_accounts loaded',
  );

  return payload;
}

export async function loadMeridianActiveAccounts(now: Date = new Date()): Promise<ActiveAccountsPayload> {
  const source = process.env.MERIDIAN_SNAPSHOT_SOURCE ?? 'gcs';
  if (source === 'gcs') {
    return loadFromGcs(now);
  }
  if (source === 's3') {
    return loadFromS3(now);
  }
  // Local-file source — dev/testing only, so the household features can be
  // exercised without GCS/S3 access. Reads the JSON at MERIDIAN_SNAPSHOT_FILE.
  // Production sets MERIDIAN_SNAPSHOT_SOURCE to gcs/s3; this branch is inert
  // there. `now` is unused (file loader derives as_of from filename/mtime).
  if (source === 'file') {
    const filePath = process.env.MERIDIAN_SNAPSHOT_FILE;
    if (!filePath) {
      throw new ActiveAccountsLoadError(
        'MERIDIAN_SNAPSHOT_SOURCE=file but MERIDIAN_SNAPSHOT_FILE is not set',
        'file',
      );
    }
    return loadMeridianActiveAccountsFromFile(filePath);
  }
  throw new ActiveAccountsLoadError(
    `Unsupported MERIDIAN_SNAPSHOT_SOURCE=${source}; supported: 'gcs', 's3', 'file'`,
    source,
  );
}

/**
 * Bonus / integration entry point: load an active_accounts JSON from a local
 * file path. Mirrors `loadMeridianSnapshotFromFile` for the templates loader.
 * Not wired into the runner — production reads from GCS only.
 */
export async function loadMeridianActiveAccountsFromFile(
  filePath: string,
  asOfOverride?: string,
): Promise<ActiveAccountsPayload> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new ActiveAccountsLoadError(`Cannot read ${filePath}: ${(err as Error).message}`, 'file');
  }
  const parsed = parsePayloadOrThrow(raw, filePath);

  let asOf: string | null = null;
  if (asOfOverride !== undefined) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(asOfOverride)) {
      asOf = new Date(`${asOfOverride}T00:00:00.000Z`).toISOString();
    } else {
      const parsedDate = new Date(asOfOverride);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new ActiveAccountsLoadError(`Invalid asOfOverride: ${asOfOverride}`, 'file');
      }
      asOf = parsedDate.toISOString();
    }
  }
  if (!asOf) asOf = deriveAsOfFromFilename(filePath);
  if (!asOf) {
    try {
      const stat = await fs.stat(filePath);
      asOf = stat.mtime.toISOString();
    } catch (err) {
      throw new ActiveAccountsLoadError(
        `Cannot derive as_of for ${filePath}: filename does not parse as YYYY-MM-DD.json and stat failed (${(err as Error).message})`,
        'file',
      );
    }
  }

  return buildPayload({ raw: parsed, sourceLabel: filePath, asOf });
}

/**
 * Convert the loaded payload into the runtime `HouseholdConfig` shape
 * consumed by `comparePositionsToMeridian` (v1 — household-rollup) and
 * `comparePositionsToMeridianPerAccount` (v2). The mapping is direct:
 *   - `byAccountNumber.get(ULID)` → `{accountNumber, householdName, accountTitle, householdId}`
 *   - `householdNames` is the deduped set of `household_name` values.
 *   - `entries` is sorted by `accountNumber` ASC for deterministic snapshots.
 *
 * `HouseholdConfigError` is thrown on a structural mismatch (zero accounts —
 * shouldn't happen because the loader's `.min(1)` schema rejects empty arrays,
 * but kept as a belt-and-suspenders guard for synthetic-fixture corner cases).
 */
export function toHouseholdConfig(payload: ActiveAccountsPayload): HouseholdConfig {
  if (payload.accounts.length === 0) {
    throw new HouseholdConfigError('active_accounts payload contained zero accounts after parsing');
  }
  const entries: HouseholdEntry[] = payload.accounts
    .map((row) => ({
      accountNumber: row.tradingAccountNo,
      householdName: row.householdName,
      accountTitle: row.accountTitle,
      householdId: row.householdId,
      accountType: row.accountType,
    }))
    .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  const byAccountNumber = new Map<string, HouseholdEntry>();
  for (const entry of entries) byAccountNumber.set(entry.accountNumber, entry);

  const householdNames = new Set(entries.map((e) => e.householdName));

  return { byAccountNumber, householdNames, entries };
}
