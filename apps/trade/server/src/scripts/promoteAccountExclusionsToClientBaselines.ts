/**
 * Promotes account-level exclusions to client-level baselines when coverage is
 * complete across a client's account scope and side flags are consistent.
 *
 * Usage:
 *   npx tsx src/scripts/promoteAccountExclusionsToClientBaselines.ts
 *   npx tsx src/scripts/promoteAccountExclusionsToClientBaselines.ts --scope funded --commit
 */

import { parseArgs } from 'node:util';
import pool from '../db/pool.js';
import { getCachedClients, getClientIdsByAccountUlid } from '../services/warehouse.js';

type ExclusionKind = 'advisor' | 'client';
type ScopeMode = 'funded' | 'all';

interface AccountExclusionRow {
  account_id: string;
  ticker: string;
  kind: ExclusionKind;
  no_buy: boolean;
  no_sell: boolean;
}

interface ClientExclusionRow {
  client_id: string;
  ticker: string;
  kind: ExclusionKind;
  no_buy: boolean;
  no_sell: boolean;
}

interface CandidateAccumulator {
  clientId: string;
  ticker: string;
  kind: ExclusionKind;
  noBuy: boolean;
  noSell: boolean;
  mixedSides: boolean;
  coveredAccountIds: Set<string>;
}

interface PromotionCandidate {
  clientId: string;
  ticker: string;
  kind: ExclusionKind;
  noBuy: boolean;
  noSell: boolean;
}

interface PromotionSummary {
  accountRowsRead: number;
  clientsWithScope: number;
  candidateKeysEvaluated: number;
  skippedPartialCoverage: number;
  skippedMixedSides: number;
  fullCoverageCandidates: number;
  existingExactDuplicates: number;
  existingSideConflicts: number;
  readyToInsert: number;
  inserted: number;
}

function key(parts: readonly string[]): string {
  return parts.join('::');
}

async function ensureTableExists(tableName: string): Promise<void> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = $1`,
    [tableName],
  );
  if (rows.length === 0) {
    throw new Error(`Table ${tableName} does not exist. Run migrations first.`);
  }
}

function printSummary(summary: PromotionSummary): void {
  console.log('');
  console.log('Promotion summary');
  console.log(`- Account exclusion rows read: ${summary.accountRowsRead}`);
  console.log(`- Clients with scoped accounts: ${summary.clientsWithScope}`);
  console.log(`- Candidate keys evaluated: ${summary.candidateKeysEvaluated}`);
  console.log(`- Skipped (partial coverage): ${summary.skippedPartialCoverage}`);
  console.log(`- Skipped (mixed side flags): ${summary.skippedMixedSides}`);
  console.log(`- Full-coverage candidates: ${summary.fullCoverageCandidates}`);
  console.log(`- Existing exact duplicates: ${summary.existingExactDuplicates}`);
  console.log(`- Existing side conflicts: ${summary.existingSideConflicts}`);
  console.log(`- Ready to insert: ${summary.readyToInsert}`);
  console.log(`- Inserted: ${summary.inserted}`);
  console.log('');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      scope: { type: 'string' },
      kind: { type: 'string' },
      author: { type: 'string' },
      commit: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const scopeArg = (values.scope ?? 'funded').toLowerCase();
  if (scopeArg !== 'funded' && scopeArg !== 'all') {
    throw new Error(`Invalid --scope "${scopeArg}". Use "funded" or "all".`);
  }
  const scope = scopeArg as ScopeMode;

  const kindArg = values.kind ? values.kind.toLowerCase() : null;
  if (kindArg !== null && kindArg !== 'advisor' && kindArg !== 'client') {
    throw new Error(`Invalid --kind "${kindArg}". Use "advisor" or "client".`);
  }
  const kindFilter = kindArg as ExclusionKind | null;
  const author = values.author?.trim() || 'Account Exclusion Promotion';
  const commit = values.commit === true;

  await ensureTableExists('account_exclusions');
  await ensureTableExists('client_exclusions');

  const accountQuery = kindFilter
    ? {
        sql: `SELECT account_id, ticker, kind, no_buy, no_sell
              FROM account_exclusions
              WHERE kind = $1`,
        params: [kindFilter] as unknown[],
      }
    : {
        sql: `SELECT account_id, ticker, kind, no_buy, no_sell
              FROM account_exclusions`,
        params: [] as unknown[],
      };
  const { rows: accountRows } = await pool.query<AccountExclusionRow>(accountQuery.sql, accountQuery.params);

  const accountIds = [...new Set(accountRows.map((r) => r.account_id))];
  const clientIdsByAccount = await getClientIdsByAccountUlid(accountIds);
  const clients = await getCachedClients();

  const scopedAccountsByClient = new Map<string, Set<string>>();
  for (const client of clients) {
    const scoped = client.accounts
      .filter((acct) => (scope === 'funded' ? acct.balance > 0 : true))
      .map((acct) => acct.id);
    if (scoped.length > 0) {
      scopedAccountsByClient.set(client.id, new Set(scoped));
    }
  }

  const accumulators = new Map<string, CandidateAccumulator>();
  for (const row of accountRows) {
    const clientIds = clientIdsByAccount[row.account_id] ?? [];
    for (const clientId of clientIds) {
      const scoped = scopedAccountsByClient.get(clientId);
      if (!scoped || !scoped.has(row.account_id)) continue;

      const k = key([clientId, row.ticker, row.kind]);
      const existing = accumulators.get(k);
      if (!existing) {
        accumulators.set(k, {
          clientId,
          ticker: row.ticker,
          kind: row.kind,
          noBuy: row.no_buy,
          noSell: row.no_sell,
          mixedSides: false,
          coveredAccountIds: new Set([row.account_id]),
        });
        continue;
      }

      existing.coveredAccountIds.add(row.account_id);
      if (existing.noBuy !== row.no_buy || existing.noSell !== row.no_sell) {
        existing.mixedSides = true;
      }
    }
  }

  const candidates: PromotionCandidate[] = [];
  let skippedPartialCoverage = 0;
  let skippedMixedSides = 0;

  for (const acc of accumulators.values()) {
    const scoped = scopedAccountsByClient.get(acc.clientId);
    if (!scoped || scoped.size === 0) continue;

    if (acc.mixedSides) {
      skippedMixedSides++;
      continue;
    }
    if (acc.coveredAccountIds.size !== scoped.size) {
      skippedPartialCoverage++;
      continue;
    }

    candidates.push({
      clientId: acc.clientId,
      ticker: acc.ticker,
      kind: acc.kind,
      noBuy: acc.noBuy,
      noSell: acc.noSell,
    });
  }

  const candidateClientIds = [...new Set(candidates.map((c) => c.clientId))];
  const existingClientMap = new Map<string, ClientExclusionRow>();
  if (candidateClientIds.length > 0) {
    const { rows } = await pool.query<ClientExclusionRow>(
      `SELECT client_id, ticker, kind, no_buy, no_sell
       FROM client_exclusions
       WHERE client_id = ANY($1::varchar[])`,
      [candidateClientIds],
    );
    for (const row of rows) {
      existingClientMap.set(key([row.client_id, row.ticker, row.kind]), row);
    }
  }

  const toInsert: PromotionCandidate[] = [];
  let existingExactDuplicates = 0;
  let existingSideConflicts = 0;
  for (const candidate of candidates) {
    const existing = existingClientMap.get(key([candidate.clientId, candidate.ticker, candidate.kind]));
    if (!existing) {
      toInsert.push(candidate);
      continue;
    }
    if (existing.no_buy === candidate.noBuy && existing.no_sell === candidate.noSell) {
      existingExactDuplicates++;
    } else {
      existingSideConflicts++;
    }
  }

  let inserted = 0;
  if (commit && toInsert.length > 0) {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      for (const row of toInsert) {
        const reason =
          scope === 'funded'
            ? 'Promoted from account-level exclusions (100% funded-account coverage)'
            : 'Promoted from account-level exclusions (100% account coverage)';
        const result = await dbClient.query(
          `INSERT INTO client_exclusions (client_id, ticker, kind, reason, no_buy, no_sell, created_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (client_id, ticker, kind) DO NOTHING`,
          [row.clientId, row.ticker, row.kind, reason, row.noBuy, row.noSell, author],
        );
        inserted += result.rowCount ?? 0;
      }
      await dbClient.query('COMMIT');
    } catch (err) {
      try {
        await dbClient.query('ROLLBACK');
      } catch {
        // rollback best-effort
      }
      throw err;
    } finally {
      dbClient.release();
    }
  }

  printSummary({
    accountRowsRead: accountRows.length,
    clientsWithScope: scopedAccountsByClient.size,
    candidateKeysEvaluated: accumulators.size,
    skippedPartialCoverage,
    skippedMixedSides,
    fullCoverageCandidates: candidates.length,
    existingExactDuplicates,
    existingSideConflicts,
    readyToInsert: toInsert.length,
    inserted,
  });

  if (existingSideConflicts > 0) {
    console.log('Conflicts detected (client exclusion exists with different side flags).');
    console.log('No updates were applied to conflicting client rows.');
  }

  if (!commit) {
    console.log('Dry-run only. Re-run with --commit to insert promoted client baselines.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
