import type { ClientExclusion, ClientExclusionKind, TradeRequest } from '@trade-request/shared';
import {
  buildCompliancePdf,
  buildRequestPdf,
  type ExportAccountExclusion,
  type ExportIdentity,
} from '@trade-request/shared/pdf';
import { recordDb } from '../db/recordSource.js';
import { OpsPortalRecordsUnavailableError } from '../db/opsPortalRecords.js';
import * as warehouse from './warehouse.js';
import logger from '../lib/logger.js';

// Server-side counterpart to the browser export flow in `client/src/App.tsx`
// (loadStandingExclusionsForRequests / loadAccountExclusionsForRequests) and
// `client/src/components/RequestModal.tsx`. The PDF rendering itself is shared
// (`@trade-request/shared/pdf`); this module only gathers the exclusion data
// the renderer needs and turns the resulting document into base64 for MCP.

interface ClientExclusionRow {
  id: string;
  client_id: string;
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  no_buy: boolean;
  no_sell: boolean;
  created_by_name: string;
  created_at: Date | string;
}

interface AccountExclusionRow {
  id: string;
  account_id: string;
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  no_buy: boolean;
  no_sell: boolean;
}

function distinctClientIds(requests: TradeRequest[]): string[] {
  const ids = new Set<string>();
  for (const req of requests) {
    const reqIds = req.clientIds?.length ? req.clientIds : [req.clientId];
    for (const id of reqIds) if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Standing client-level exclusions grouped by clientId. Mirrors the
 * `POST /clients/exclusions/bulk` route body. Returns an entry (possibly empty)
 * for every requested id.
 */
export async function loadStandingClientExclusions(clientIds: string[]): Promise<Record<string, ClientExclusion[]>> {
  const ids = [...new Set(clientIds)].filter(Boolean);
  const grouped: Record<string, ClientExclusion[]> = {};
  for (const id of ids) grouped[id] = [];
  if (ids.length === 0) return grouped;

  const { rows } = await recordDb().query<ClientExclusionRow>(
    `SELECT id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
     FROM client_exclusions
     WHERE client_id = ANY($1::varchar[])
     ORDER BY client_id, kind, ticker`,
    [ids],
  );

  for (const row of rows) {
    (grouped[row.client_id] ??= []).push({
      id: row.id,
      clientId: row.client_id,
      ticker: row.ticker,
      kind: row.kind,
      reason: row.reason,
      noBuy: row.no_buy,
      noSell: row.no_sell,
      createdByName: row.created_by_name,
      createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
    });
  }
  return grouped;
}

/**
 * Standing account-level exclusions reshaped by request id, matching the export
 * shape the shared renderer expects. Resolves each request's selected account
 * NUMBERS to account ULIDs via the Warehouse client cache (same resolution the
 * browser does through `clientMap`), then bulk-queries `account_exclusions`.
 *
 * Best-effort: if Warehouse is not configured or any lookup fails, returns `{}`
 * so the PDF still renders with per-request snapshot + standing CLIENT
 * exclusions. This mirrors the browser's try/catch degradation.
 */
export async function loadAccountExclusionsForRequests(
  requests: TradeRequest[],
): Promise<Record<string, ExportAccountExclusion[]>> {
  try {
    if (!warehouse.isConfigured() || requests.length === 0) return {};

    // Build `${clientId}::${accountNumber}` -> accountId across every client leg.
    const accountIdByClientAndNumber = new Map<string, string>();
    for (const clientId of distinctClientIds(requests)) {
      const accounts = await warehouse.getClientAccounts(clientId);
      for (const acct of accounts) {
        accountIdByClientAndNumber.set(`${clientId}::${acct.accountNumber}`, acct.id);
      }
    }

    const requestAccountRefs = new Map<string, Array<{ accountNumber: string; accountId: string }>>();
    const accountIds = new Set<string>();
    for (const req of requests) {
      const clientIds = req.clientIds?.length ? req.clientIds : [req.clientId];
      const refs: Array<{ accountNumber: string; accountId: string }> = [];
      const seenAccountIds = new Set<string>();
      for (const accountNumber of req.selectedAccounts ?? []) {
        let accountId: string | null = null;
        for (const clientId of clientIds) {
          const resolved = accountIdByClientAndNumber.get(`${clientId}::${accountNumber}`);
          if (resolved) {
            accountId = resolved;
            break;
          }
        }
        if (!accountId || seenAccountIds.has(accountId)) continue;
        seenAccountIds.add(accountId);
        refs.push({ accountNumber, accountId });
        accountIds.add(accountId);
      }
      if (refs.length > 0) requestAccountRefs.set(req.id, refs);
    }

    if (accountIds.size === 0) return {};

    const { rows } = await recordDb().query<AccountExclusionRow>(
      `SELECT id, account_id, ticker, kind, reason, no_buy, no_sell
       FROM account_exclusions
       WHERE account_id = ANY($1::varchar[])
       ORDER BY account_id, kind, ticker`,
      [[...accountIds]],
    );

    const byAccount = new Map<string, Array<Omit<ExportAccountExclusion, 'accountNumber'>>>();
    for (const row of rows) {
      const list = byAccount.get(row.account_id) ?? [];
      list.push({ kind: row.kind, ticker: row.ticker, reason: row.reason, noBuy: row.no_buy, noSell: row.no_sell });
      byAccount.set(row.account_id, list);
    }

    const byRequest: Record<string, ExportAccountExclusion[]> = {};
    for (const [requestId, refs] of requestAccountRefs.entries()) {
      const flattened: ExportAccountExclusion[] = [];
      for (const ref of refs) {
        for (const ex of byAccount.get(ref.accountId) ?? []) {
          flattened.push({ accountNumber: ref.accountNumber, ...ex });
        }
      }
      if (flattened.length > 0) byRequest[requestId] = flattened;
    }
    return byRequest;
  } catch (err) {
    if (err instanceof OpsPortalRecordsUnavailableError) throw err;
    logger.warn({ err }, 'Failed to load account exclusions for PDF export; rendering without them');
    return {};
  }
}

export interface RenderedPdf {
  filename: string;
  /** Base64-encoded PDF bytes, suitable for an MCP embedded resource blob. */
  base64: string;
  /** Raw byte length (before base64 encoding). */
  bytes: number;
}

function docToRendered(doc: ReturnType<typeof buildRequestPdf>['doc'], filename: string): RenderedPdf {
  const arrayBuffer = doc.output('arraybuffer') as ArrayBuffer;
  const buf = Buffer.from(new Uint8Array(arrayBuffer));
  return { filename, base64: buf.toString('base64'), bytes: buf.length };
}

/** Render a single trade request to a base64 PDF (matches the in-app download). */
export async function renderRequestPdf(request: TradeRequest, exporter: ExportIdentity): Promise<RenderedPdf> {
  const accountExclusions = (await loadAccountExclusionsForRequests([request]))[request.id] ?? [];
  const { doc, filename } = buildRequestPdf(request, exporter, accountExclusions);
  return docToRendered(doc, filename);
}

/** Render the multi-request compliance report to a base64 PDF. */
export async function renderCompliancePdf(requests: TradeRequest[], exporter: ExportIdentity): Promise<RenderedPdf> {
  const [standing, accountExclusions] = await Promise.all([
    loadStandingClientExclusions(distinctClientIds(requests)),
    loadAccountExclusionsForRequests(requests),
  ]);
  const { doc, filename } = buildCompliancePdf(requests, exporter, standing, accountExclusions);
  return docToRendered(doc, filename);
}
