import logger from '@/lib/trade-requests/log';

/**
 * Canonical types + shared loader primitives for the Meridian drift surface.
 *
 * Pre-2026-Q3 history: this file owned a flat-array GCS loader that read
 * `gs://${MERIDIAN_SNAPSHOT_BUCKET}/meridian/snapshots/<YYYY-MM-DD>.json`
 * (one row per `(account, security)` tuple). The 2026-Q3 Meridian-format
 * cutover (`docs/plans/2026-q3-drift-v2-meridian-format-cutover.md`)
 * replaces that flat shape with two GCS files: an active_accounts file
 * (households + titles) and a templates file (per-account allocation targets,
 * nested constituents).
 *
 * What stays here:
 *   - `MeridianSnapshot` / `MeridianSnapshotEntry` interfaces — the
 *     internal in-memory shape the comparator consumes. The templates loader
 *     (`meridianTemplates.ts`) flattens the new nested wire shape into this
 *     interface so the downstream comparator does not change.
 *   - `SnapshotLoadError` — thrown by both new loaders (templates +
 *     active_accounts can also re-export). Consumers (`registryDriftRunner.ts`,
 *     `routes/internal.ts`) catch by type and translate to HTTP 503 so
 *     Cloud Scheduler retries kick in.
 *   - `INACTIVE_APEX_ACCOUNTS` / `CORPORATE_APEX_ACCOUNTS` — defense-in-depth
 *     deny lists (decision #9 of the cutover plan). The templates loader
 *     applies them at parse time so the comparator never sees the filtered
 *     ULIDs.
 *   - `STALE_SNAPSHOT_THRESHOLD_DAYS` / `WEIGHT_SUM_TOLERANCE_PCT` — shared
 *     constants used by both new loaders.
 *   - `deriveAsOfFromFilename` — filename-date parsing helper.
 *   - `groupMeridianRows` — exported for legacy unit tests that pin the
 *     grouping algorithm contract. No runtime consumer post-cutover; can be
 *     deleted in a follow-up PR once the test cases are migrated.
 *
 * What is gone (deleted in the 2026-Q3 cutover):
 *   - `loadMeridianSnapshot(now)` — replaced by `loadMeridianTemplates`
 *     in `./meridianTemplates.ts`. The runner imports from there directly.
 *   - `loadMeridianSnapshotFromFile(path, asOfOverride?)` — replaced by
 *     `loadMeridianTemplatesFromFile`.
 *   - The flat-row Zod schemas (`MeridianRowSchema`, `parseRowsOrThrow`,
 *     etc.). The new wire shape has nested constituents and is parsed by the
 *     templates loader.
 *   - `_setStorageFactoryForTests` — moved to the templates loader (test
 *     stubs target the new module).
 */

/**
 * Per-account internal shape the comparator consumes. Built by
 * `meridianTemplates.ts:buildSnapshot` from the nested Meridian export.
 *
 * `weights` is percent-scale (0..100); a synthetic `__EQUITY_BASKET__` key
 * may appear when the template has opaque `My Firm` / `Personal` sleeve
 * constituents (see `meridianTemplates.ts:EQUITY_BASKET_SYMBOL`).
 */
export interface MeridianSnapshotEntry {
  account: string;
  /** Firm-baked account title from the active_accounts export OR snapshot fallback. */
  accountTitle?: string;
  templateName?: string;
  weights: Record<string, number>;
  asOf?: string;
}

export interface MeridianSnapshot {
  generatedAt?: string;
  entries: readonly MeridianSnapshotEntry[];
}

export class SnapshotLoadError extends Error {
  public readonly status = 503;
  public readonly source: string;
  constructor(message: string, source: string) {
    super(message);
    this.name = 'SnapshotLoadError';
    this.source = source;
  }
}

/**
 * Accounts confirmed inactive at the custodian but still appearing in
 * Meridian exports. Excluded from drift comparison at parse time.
 *
 * To add an entry: include the 26-char ULID and a comment with the
 * account_title + the date / source of the inactive confirmation.
 *
 * 2026-Q3 cutover note: this set is the belt-and-suspenders guard alongside
 * the active_accounts.json roster filter (decision #9). The firm's
 * active_accounts export already excludes these accounts, but the templates
 * file may still carry them — verified for `01SYNTHD7WE9TKCBRPS3BQMGTG`
 * (Adaline Bernhard - Brokerage Companion), which is in templates_20260515.json
 * but NOT in active_accounts_20260515.json.
 */
export const INACTIVE_APEX_ACCOUNTS: ReadonlySet<string> = new Set([
  // 2026-05-13 user confirmation (chat): Adaline Bernhard - Brokerage Companion
  '01SYNTHD7WE9TKCBRPS3BQMGTG',
]);

/**
 * Apex corporate accounts that show in Meridian exports, hold cash only,
 * and will never be invested. Excluded from drift comparison so they don't
 * churn the v2 comparator or `drift_unmapped_detail` log.
 *
 * To add an entry: include the 26-char ULID and a comment with the date /
 * source confirming the account is corporate / never-invested.
 */
export const CORPORATE_APEX_ACCOUNTS: ReadonlySet<string> = new Set([
  // 2026-05-13 user confirmation (chat): corporate account, never invested
  '01SYNTH6BDYNAGTJ07KC0SFYGY',
  // 2026-05-13 user confirmation (chat): corporate account, never invested
  '01SYNTH1B11MYXFS3Q5B5D2WNW',
  // 2026-05-13 user confirmation (chat): corporate account, never invested
  '01SYNTH69JZYE3TD78SPZ4PBWK',
  // 2026-05-13 user confirmation (chat): corporate account, never invested
  '01SYNTH85BR7BT1ZPYKBDZAC9C',
]);

/**
 * Templates refresh on a monthly cadence (per ticket monthly-cadence
 * decision May 12, 2026). Loaders reject snapshots more than 35 days stale.
 */
export const STALE_SNAPSHOT_THRESHOLD_DAYS = 35;

/**
 * Per-account weight-sum tolerance (±1.0pp around 100). Sums outside this
 * band warn but do not abort the run — a real data anomaly (e.g. the known
 * 56.2% Adalberto Bergstrom Roth template that resolves in next Monday's refresh).
 */
export const WEIGHT_SUM_TOLERANCE_PCT = 1.0;

const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.json)?$/;

/**
 * Derive an ISO timestamp from a GCS object name like
 * `meridian/templates/2026-05-15.json`. Returns `null` when the basename
 * does not match `YYYY-MM-DD(.json)?` so the caller can fall back to GCS
 * object metadata (`updated`).
 */
export function deriveAsOfFromFilename(fileName: string): string | null {
  // Last path segment only — handles both bare basenames and full GCS paths.
  const lastSlash = fileName.lastIndexOf('/');
  const base = lastSlash >= 0 ? fileName.slice(lastSlash + 1) : fileName;
  const match = base.match(FILENAME_DATE_RE);
  if (!match) return null;
  const datePart = match[1];
  const parsed = new Date(`${datePart}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Legacy flat-row grouper. Pre-2026-Q3 the GCS snapshot was a flat array of
 * `(account, security)` rows; this helper aggregated weights by
 * `external_account_no`. Retained as exported so the corresponding
 * `meridianSnapshot.test.ts` unit cases (which exercise duplicate-row
 * aggregation, multiple-template warn, weight-sum tolerance, account_title
 * threading) continue to pass without rewriting. No runtime consumer
 * post-cutover — `meridianTemplates.ts` parses the new nested shape
 * directly. A follow-up PR may delete both this function and its tests
 * once the team is confident the new loader is stable.
 */
interface FlatGroupingRow {
  external_account_no: string;
  account_id?: number | string;
  master_id?: string;
  template_name?: string;
  account_title?: string;
  security: string;
  alloc_pct: number;
}

interface FlatGroupingInput {
  rows: readonly FlatGroupingRow[];
  sourceLabel: string;
  asOf: string;
}

const EXPECTED_WEIGHT_SUM_PCT_LEGACY = 100;

export function groupMeridianRows(input: FlatGroupingInput): MeridianSnapshotEntry[] {
  const { rows, sourceLabel, asOf } = input;
  interface Accumulator {
    weights: Record<string, number>;
    templateNames: Set<string>;
    lastTemplateName: string | undefined;
    lastAccountTitle: string | undefined;
    rowCount: number;
  }
  const byAccount = new Map<string, Accumulator>();

  for (const row of rows) {
    const key = row.external_account_no;
    let acc = byAccount.get(key);
    if (!acc) {
      acc = {
        weights: {},
        templateNames: new Set(),
        lastTemplateName: undefined,
        lastAccountTitle: undefined,
        rowCount: 0,
      };
      byAccount.set(key, acc);
    }
    acc.weights[row.security] = (acc.weights[row.security] ?? 0) + row.alloc_pct;
    acc.rowCount += 1;
    if (typeof row.template_name === 'string' && row.template_name.length > 0) {
      acc.templateNames.add(row.template_name);
      acc.lastTemplateName = row.template_name;
    }
    if (typeof row.account_title === 'string' && row.account_title.length > 0) {
      acc.lastAccountTitle = row.account_title;
    }
  }

  const entries: MeridianSnapshotEntry[] = [];
  for (const [account, acc] of byAccount) {
    if (acc.templateNames.size > 1) {
      logger.warn(
        {
          event: 'snapshot_multiple_templates_per_account',
          source: sourceLabel,
          account,
          templateNames: [...acc.templateNames],
        },
        'meridian snapshot: multiple template_name values for one external_account_no (taking last seen)',
      );
    }

    const sum = Object.values(acc.weights).reduce((s, v) => s + v, 0);
    const drift = Math.abs(sum - EXPECTED_WEIGHT_SUM_PCT_LEGACY);
    if (drift > WEIGHT_SUM_TOLERANCE_PCT) {
      logger.warn(
        {
          event: 'snapshot_weight_sum_anomaly',
          source: sourceLabel,
          account,
          rowCount: acc.rowCount,
          observedSumPct: sum,
          expectedSumPct: EXPECTED_WEIGHT_SUM_PCT_LEGACY,
          tolerancePct: WEIGHT_SUM_TOLERANCE_PCT,
        },
        'meridian snapshot: per-account weight sum outside tolerance',
      );
    }

    entries.push({
      account,
      accountTitle: acc.lastAccountTitle,
      templateName: acc.lastTemplateName,
      weights: acc.weights,
      asOf,
    });
  }

  entries.sort((a, b) => a.account.localeCompare(b.account));
  return entries;
}
