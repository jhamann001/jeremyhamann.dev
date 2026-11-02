import { promises as fs } from 'node:fs';
import { Storage } from '@google-cloud/storage';
import { getS3Client, pickNewestFeedFile, _setS3ClientFactoryForTests } from '@/lib/trade-requests/sources/meridian-s3';

// Re-exported so existing imports (and tests) that referenced the seam from
// this module keep working after the S3 plumbing moved to meridianS3.ts.
export { _setS3ClientFactoryForTests };
import { z } from 'zod';
import logger from '@/lib/trade-requests/log';
import {
  type MeridianSnapshot,
  type MeridianSnapshotEntry,
  SnapshotLoadError,
  STALE_SNAPSHOT_THRESHOLD_DAYS,
  WEIGHT_SUM_TOLERANCE_PCT,
  INACTIVE_APEX_ACCOUNTS,
  CORPORATE_APEX_ACCOUNTS,
  deriveAsOfFromFilename,
} from '@/lib/trade-requests/sources/meridian-snapshot';
import { classifyTemplateConstituent } from '@/lib/trade-requests/sources/data/instruments';

/**
 * Cloud-storage loader for the Meridian `templates.json` export — the
 * per-account allocation targets used by the drift comparator.
 *
 * Source is selected by `MERIDIAN_SNAPSHOT_SOURCE` (`gcs` default, `s3`):
 *   - GCS path: `gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/templates/<YYYY-MM-DD>.json`
 *   - S3 path:  `s3://${MERIDIAN_SNAPSHOT_S3_BUCKET}/<prefix>/<YYYY-MM-DD>.json`
 *     (prefix defaults to `meridian/templates/`, override via
 *     `MERIDIAN_SNAPSHOT_S3_PREFIX`). Both loaders return the same
 *     `MeridianSnapshot` shape so the comparator is source-agnostic.
 * Latest-by-filename selection mirrors the legacy snapshot loader pattern.
 * Stale-file rejection reuses `STALE_SNAPSHOT_THRESHOLD_DAYS` (35) from the
 * snapshot module so both new files stay in lockstep with one staleness
 * contract.
 *
 * The output is the existing `MeridianSnapshot` shape so the downstream
 * comparator (`comparePositionsToMeridianPerAccount`) needs no changes.
 *
 * Bucket classification rule (§2 cutover plan decision #7):
 *   - `securityType === 'IndividualSecurity'` → `security` is a real ticker;
 *     route through `classifySymbol` and emit a per-symbol weight that the
 *     comparator's cash/fixed drilldown can use.
 *   - `securityType === 'My Firm' | 'Personal'` → opaque sleeve ID; aggregate
 *     `alloc_pct` into a synthetic `__EQUITY_BASKET__` weight that the
 *     comparator routes to the equity bucket via `classifySymbol`'s default
 *     branch (no `INSTRUMENTS` entry → falls through to equity).
 *
 * The synthetic key intentionally fails the `/^[A-Z]{3,5}XX$/` regex used by
 * `suspectedCashEquivMisclassified`, so it never pollutes the safety-net warn
 * log. See `positionDriftAccounts.ts:75-80`.
 */

export const EQUITY_BASKET_SYMBOL = '__EQUITY_BASKET__';

const TemplateConstituentSchema = z
  .object({
    security: z.string().min(1),
    securityType: z.string().optional(),
    security_name: z.string().optional(),
    alloc_pct: z.number().finite(),
  })
  .passthrough();

const TemplateSchema = z
  .object({
    template_id: z.union([z.number(), z.string()]).optional(),
    template_name: z.string().min(1),
    is_levered: z.union([z.number(), z.boolean()]).optional(),
    tolerance: z.number().finite().optional(),
    constituents: z.array(TemplateConstituentSchema).min(1, 'each template must carry ≥1 constituent'),
  })
  .passthrough();

const TemplateAccountSchema = z
  .object({
    account_id: z.union([z.number(), z.string()]).optional(),
    account_title: z.string().optional(),
    external_account_no: z.string().min(1),
    master_id: z.string().min(1),
    templates: z.array(TemplateSchema).min(1, 'every templates.accounts[] row must carry ≥1 template'),
  })
  .passthrough();

const TemplatesPayloadSchema = z
  .object({
    generated_at: z.string().optional(),
    firm_id: z.union([z.string(), z.number()]).optional(),
    account_count: z.number().int().nonnegative().optional(),
    raw_row_count: z.number().int().nonnegative().optional(),
    template_count: z.number().int().nonnegative().optional(),
    accounts: z.array(TemplateAccountSchema).min(1, 'templates payload must contain ≥1 account'),
  })
  .passthrough();

type TemplateAccount = z.infer<typeof TemplateAccountSchema>;

const STALE_SNAPSHOT_THRESHOLD_MS = STALE_SNAPSHOT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
const EXPECTED_WEIGHT_SUM_PCT = 100;

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

function sourceForLabel(label: string): string {
  if (label.startsWith('gs://')) return 'gcs';
  if (label.startsWith('s3://')) return 's3';
  return 'file';
}

function parsePayloadOrThrow(raw: string, sourceLabel: string): z.infer<typeof TemplatesPayloadSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SnapshotLoadError(
      `Templates file ${sourceLabel} is not valid JSON: ${(err as Error).message}`,
      sourceForLabel(sourceLabel),
    );
  }
  const result = TemplatesPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new SnapshotLoadError(
      `Templates file ${sourceLabel} failed schema validation: ${result.error.message}`,
      sourceForLabel(sourceLabel),
    );
  }
  return result.data;
}

interface BuildSnapshotInput {
  parsed: z.infer<typeof TemplatesPayloadSchema>;
  sourceLabel: string;
  asOf: string;
}

function buildSnapshot(input: BuildSnapshotInput): MeridianSnapshot {
  const filteredAccounts: TemplateAccount[] = input.parsed.accounts.filter((acct) => {
    if (acct.master_id !== 'CEDAR_RIDGE') return false;
    if (INACTIVE_APEX_ACCOUNTS.has(acct.external_account_no)) return false;
    if (CORPORATE_APEX_ACCOUNTS.has(acct.external_account_no)) return false;
    return true;
  });

  const entries: MeridianSnapshotEntry[] = [];
  for (const acct of filteredAccounts) {
    if (acct.templates.length > 1) {
      logger.warn(
        {
          event: 'templates_multiple_templates_per_account',
          source: input.sourceLabel,
          account: acct.external_account_no,
          templateNames: acct.templates.map((t) => t.template_name),
        },
        'meridian templates: multiple templates for one external_account_no (taking last seen)',
      );
    }
    const template = acct.templates[acct.templates.length - 1];

    const weights: Record<string, number> = {};
    let equityBasketSum = 0;
    for (const c of template.constituents) {
      const bucket = classifyTemplateConstituent({ security: c.security, securityType: c.securityType }, logger);
      const isOpaqueEquity =
        bucket === 'equity' && c.securityType !== 'IndividualSecurity' && c.securityType !== undefined;
      if (isOpaqueEquity) {
        equityBasketSum += c.alloc_pct;
      } else {
        weights[c.security] = (weights[c.security] ?? 0) + c.alloc_pct;
      }
    }
    if (equityBasketSum > 0) {
      weights[EQUITY_BASKET_SYMBOL] = (weights[EQUITY_BASKET_SYMBOL] ?? 0) + equityBasketSum;
    }

    const sum = Object.values(weights).reduce((s, v) => s + v, 0);
    const drift = Math.abs(sum - EXPECTED_WEIGHT_SUM_PCT);
    if (drift > WEIGHT_SUM_TOLERANCE_PCT) {
      logger.warn(
        {
          event: 'templates_weight_sum_anomaly',
          source: input.sourceLabel,
          account: acct.external_account_no,
          rowCount: template.constituents.length,
          observedSumPct: sum,
          expectedSumPct: EXPECTED_WEIGHT_SUM_PCT,
          tolerancePct: WEIGHT_SUM_TOLERANCE_PCT,
        },
        'meridian templates: per-account weight sum outside tolerance',
      );
    }

    entries.push({
      account: acct.external_account_no,
      accountTitle: acct.account_title,
      templateName: template.template_name,
      weights,
      asOf: input.asOf,
    });
  }

  entries.sort((a, b) => a.account.localeCompare(b.account));
  return { generatedAt: input.asOf, entries };
}

async function loadFromGcs(now: Date): Promise<MeridianSnapshot> {
  const source = 'gcs';
  const bucketName = process.env.MERIDIAN_SNAPSHOT_BUCKET;
  if (!bucketName) {
    throw new SnapshotLoadError('MERIDIAN_SNAPSHOT_BUCKET is not configured', source);
  }

  const storage = storageFactory();

  let files: GcsFileLike[];
  try {
    const [allFiles] = await storage.bucket(bucketName).getFiles({ prefix: 'meridian/templates/' });
    files = allFiles;
  } catch (err) {
    throw new SnapshotLoadError(
      `Cannot list gs://${bucketName}/meridian/templates/: ${(err as Error).message}`,
      source,
    );
  }

  const jsonFiles = files.filter((file) => file.name.endsWith('.json'));
  if (jsonFiles.length === 0) {
    throw new SnapshotLoadError(`No templates files found under gs://${bucketName}/meridian/templates/`, source);
  }

  jsonFiles.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const latest = jsonFiles[0];
  const sourceLabel = `gs://${bucketName}/${latest.name}`;

  let raw: string;
  try {
    const [buffer] = await latest.download();
    raw = buffer.toString('utf-8');
  } catch (err) {
    throw new SnapshotLoadError(`Cannot download ${latest.name}: ${(err as Error).message}`, source);
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
          event: 'templates_metadata_fetch_failed',
          source,
          file: latest.name,
          message: (err as Error).message,
        },
        'meridian templates: getMetadata() failed; falling back',
      );
    }
  }
  if (!asOf) {
    throw new SnapshotLoadError(
      `Templates file ${latest.name} has no parseable date in filename (expected YYYY-MM-DD.json) and no GCS object metadata updated time`,
      source,
    );
  }

  const ageMs = now.getTime() - new Date(asOf).getTime();
  if (ageMs > STALE_SNAPSHOT_THRESHOLD_MS) {
    throw new SnapshotLoadError(
      `Templates file ${latest.name} (as_of ${asOf}) is older than ${STALE_SNAPSHOT_THRESHOLD_DAYS} days`,
      source,
    );
  }

  const snapshot = buildSnapshot({ parsed, sourceLabel, asOf });

  logger.info(
    {
      event: 'templates_loaded',
      source,
      file: latest.name,
      asOf,
      accountCount: snapshot.entries.length,
    },
    'meridian templates loaded',
  );

  return snapshot;
}

/**
 * S3 loader — reads the newest `s3://${MERIDIAN_SNAPSHOT_S3_BUCKET}/<prefix>/<YYYY-MM-DD>.json`
 * where Meridian delivers the templates export directly. Behaviourally
 * identical to `loadFromGcs` (latest-by-filename selection, filename/object
 * date derivation, 35-day staleness rejection, same `MeridianSnapshot`
 * output) so the downstream comparator is unaffected by the source switch.
 *
 * Prefix defaults to `meridian/templates/` to match the GCS layout but can
 * be overridden via `MERIDIAN_SNAPSHOT_S3_PREFIX` since Meridian's S3 key
 * layout may differ. Credentials come from the default AWS provider chain
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY); region from
 * MERIDIAN_SNAPSHOT_S3_REGION or AWS_REGION.
 */
async function loadFromS3(now: Date): Promise<MeridianSnapshot> {
  const source = 's3';
  const bucketName = process.env.MERIDIAN_SNAPSHOT_S3_BUCKET;
  if (!bucketName) {
    throw new SnapshotLoadError('MERIDIAN_SNAPSHOT_S3_BUCKET is not configured', source);
  }
  const rawPrefix = process.env.MERIDIAN_SNAPSHOT_S3_PREFIX ?? 'Accounts-and-associations/';
  const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;

  const client = getS3Client();

  let keys: string[];
  try {
    keys = await client.listKeys(bucketName, prefix);
  } catch (err) {
    throw new SnapshotLoadError(`Cannot list s3://${bucketName}/${prefix}: ${(err as Error).message}`, source);
  }

  // Feed-aware selection: the prefix holds templates_/active_accounts_/transitions_
  // side by side, so pick the newest `templates_YYYYMMDD.json` specifically.
  const newest = pickNewestFeedFile(keys, 'templates');
  if (!newest) {
    throw new SnapshotLoadError(`No templates_YYYYMMDD.json files found under s3://${bucketName}/${prefix}`, source);
  }
  const latestKey = newest.key;
  const asOf = newest.asOf;
  const sourceLabel = `s3://${bucketName}/${latestKey}`;

  let raw: string;
  try {
    const obj = await client.download(bucketName, latestKey);
    raw = obj.body;
  } catch (err) {
    throw new SnapshotLoadError(`Cannot download ${latestKey}: ${(err as Error).message}`, source);
  }

  const parsed = parsePayloadOrThrow(raw, sourceLabel);

  const ageMs = now.getTime() - new Date(asOf).getTime();
  if (ageMs > STALE_SNAPSHOT_THRESHOLD_MS) {
    throw new SnapshotLoadError(
      `Templates file ${latestKey} (as_of ${asOf}) is older than ${STALE_SNAPSHOT_THRESHOLD_DAYS} days`,
      source,
    );
  }

  const snapshot = buildSnapshot({ parsed, sourceLabel, asOf });

  logger.info(
    {
      event: 'templates_loaded',
      source,
      file: latestKey,
      asOf,
      accountCount: snapshot.entries.length,
    },
    'meridian templates loaded',
  );

  return snapshot;
}

export async function loadMeridianTemplates(now: Date = new Date()): Promise<MeridianSnapshot> {
  const source = process.env.MERIDIAN_SNAPSHOT_SOURCE ?? 'gcs';
  if (source === 'gcs') {
    return loadFromGcs(now);
  }
  if (source === 's3') {
    return loadFromS3(now);
  }
  throw new SnapshotLoadError(`Unsupported MERIDIAN_SNAPSHOT_SOURCE=${source}; supported: 'gcs', 's3'`, source);
}

/**
 * Bonus / integration entry point: parse an Meridian templates export from
 * a local file path. Mirrors `loadMeridianSnapshotFromFile` from the legacy
 * snapshot module so the bonus-path integration tests still work end-to-end.
 * Not wired into the runner — production reads from GCS only.
 */
export async function loadMeridianTemplatesFromFile(
  filePath: string,
  asOfOverride?: string,
): Promise<MeridianSnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new SnapshotLoadError(`Cannot read ${filePath}: ${(err as Error).message}`, 'file');
  }
  const parsed = parsePayloadOrThrow(raw, filePath);

  let asOf: string | null = null;
  if (asOfOverride !== undefined) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(asOfOverride)) {
      asOf = new Date(`${asOfOverride}T00:00:00.000Z`).toISOString();
    } else {
      const parsedDate = new Date(asOfOverride);
      if (Number.isNaN(parsedDate.getTime())) {
        throw new SnapshotLoadError(`Invalid asOfOverride: ${asOfOverride}`, 'file');
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
      throw new SnapshotLoadError(
        `Cannot derive as_of for ${filePath}: filename does not parse as YYYY-MM-DD.json and stat failed (${(err as Error).message})`,
        'file',
      );
    }
  }

  return buildSnapshot({ parsed, sourceLabel: filePath, asOf });
}
