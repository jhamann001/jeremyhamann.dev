import { memo, useMemo, useState, useRef, useEffect, useCallback } from 'react';
import {
  Download,
  Loader2,
  Search,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  FileSpreadsheet,
  FileText,
} from 'lucide-react';
import type { ClientExclusion, TradeRequest, UserRole } from '@trade-request/shared';
import { StatusBadge } from './ui/StatusBadge';
import { csvEscape } from '../utils/csv';

export interface ExportAccountExclusion {
  accountNumber: string;
  kind: 'advisor' | 'client';
  ticker: string;
  reason: string;
  noBuy: boolean;
  noSell: boolean;
}

// v3.4 — CSV format extends with the DNB/DNS side prefix, matching the
// AdvisorForm textarea auto-fill format. Server-side `formatSide` helpers
// in `routes/exclusions.ts` and `services/slack.ts` use the same
// vocabulary. The trader sees the same labels everywhere.
function formatStandingSide(e: Pick<ClientExclusion, 'noBuy' | 'noSell'>): string {
  if (e.noBuy && e.noSell) return 'DNB+DNS';
  if (e.noBuy) return 'DNB';
  return 'DNS';
}

function formatStandingForCsv(entries: ClientExclusion[] | undefined, kind: 'advisor' | 'client'): string {
  if (!entries || entries.length === 0) return '';
  return entries
    .filter((e) => e.kind === kind)
    .map((e) => {
      const side = formatStandingSide(e);
      return e.reason ? `${e.ticker} (${side} - ${e.reason})` : `${e.ticker} (${side})`;
    })
    .join('; ');
}

function formatAccountStandingForCsv(
  entries: ExportAccountExclusion[] | undefined,
  kind: 'advisor' | 'client',
): string {
  if (!entries || entries.length === 0) return '';
  const byAccount = new Map<string, string[]>();
  for (const e of entries) {
    if (e.kind !== kind) continue;
    const side = formatStandingSide(e);
    const rendered = e.reason ? `${e.ticker} (${side} - ${e.reason})` : `${e.ticker} (${side})`;
    const list = byAccount.get(e.accountNumber) ?? [];
    list.push(rendered);
    byAccount.set(e.accountNumber, list);
  }
  if (byAccount.size === 0) return '';
  return Array.from(byAccount.entries())
    .map(([accountNumber, values]) => `${accountNumber}: ${values.join('; ')}`)
    .join(' || ');
}

type SortKey = 'id' | 'household' | 'tradeType' | 'date' | 'advisor' | 'submittedBy' | 'status';
type SortDir = 'asc' | 'desc';

function getSubmitter(req: TradeRequest): string {
  return req.submittedBy || req.advisor;
}

function getHousehold(req: TradeRequest): string {
  return req.clientNames?.length > 1 ? req.clientNames.join(' & ') : req.clientName;
}

const STATUS_ORDER: Record<string, number> = {
  'Pending Review': 0,
  'Needs Info': 1,
  'Pending Current Asset Liquidation': 2,
  Approved: 3,
  Rejected: 4,
  Completed: 5,
};

function compareBySortKey(a: TradeRequest, b: TradeRequest, key: SortKey, dir: SortDir): number {
  let result: number;
  switch (key) {
    case 'id':
      result = a.id.localeCompare(b.id);
      break;
    case 'household':
      result = getHousehold(a).localeCompare(getHousehold(b));
      break;
    case 'tradeType':
      result = a.tradeType.localeCompare(b.tradeType);
      break;
    case 'date':
      result = new Date(a.date).getTime() - new Date(b.date).getTime();
      break;
    case 'advisor':
      result = a.advisor.localeCompare(b.advisor);
      break;
    case 'submittedBy':
      result = getSubmitter(a).localeCompare(getSubmitter(b));
      break;
    case 'status':
      result = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
      break;
    default:
      result = 0;
  }
  return dir === 'asc' ? result : -result;
}

function SortIcon({ sortKey, columnKey, sortDir }: { sortKey: SortKey; columnKey: SortKey; sortDir: SortDir }) {
  if (sortKey !== columnKey) return <ArrowUpDown size={12} className="opacity-30" />;
  return sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />;
}

const RequestRow = memo(function RequestRow({
  request,
  role,
  onSelect,
}: {
  request: TradeRequest;
  role: UserRole;
  onSelect: (id: string) => void;
}) {
  const formattedDate = useMemo(() => new Date(request.date).toLocaleDateString(), [request.date]);
  const household = getHousehold(request);

  return (
    <tr
      role="row"
      tabIndex={0}
      aria-label={`View request ${request.id}`}
      onClick={() => onSelect(request.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(request.id);
        }
      }}
      className="border-b border-[var(--border-light)] hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
    >
      <td className="px-6 py-4 font-mono font-semibold text-[var(--text-primary)]">{request.id}</td>
      <td className="px-6 py-4 font-semibold text-[var(--text-primary)]">{household}</td>
      <td className="px-6 py-4 text-[var(--text-secondary)]">{request.tradeType}</td>
      <td className="px-6 py-4 text-[var(--text-secondary)]">{formattedDate}</td>
      {role === 'trader' && (
        <>
          <td className="px-6 py-4 text-[var(--text-secondary)]">{request.advisor}</td>
          <td className="px-6 py-4 text-[var(--text-secondary)]">{getSubmitter(request)}</td>
        </>
      )}
      <td className="px-6 py-4">
        <StatusBadge status={request.status} />
      </td>
    </tr>
  );
});

export type ExportFormat = 'csv' | 'pdf';

function ExportDropdown({
  onExport,
  exportLoading,
}: {
  onExport: (format: ExportFormat) => void;
  exportLoading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, close]);

  const handleExport = (format: ExportFormat) => {
    close();
    onExport(format);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((p) => !p)}
        disabled={exportLoading}
        aria-haspopup="true"
        aria-expanded={open}
        className="flex items-center gap-2 bg-[var(--bg-card)] hover:bg-[var(--bg-surface)] border border-[var(--border)] px-4 py-2 rounded-lg text-sm text-[var(--text-secondary)] transition-colors disabled:opacity-50"
      >
        {exportLoading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        {exportLoading ? 'Preparing Export...' : 'Export Compliance Log'}
        {!exportLoading && <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />}
      </button>
      {open && !exportLoading && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 w-56 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-lg z-50 py-1 animate-in fade-in slide-in-from-top-1"
        >
          <button
            role="menuitem"
            onClick={() => handleExport('pdf')}
            className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors text-left"
          >
            <FileText size={16} className="text-[var(--text-muted)] shrink-0" />
            <div>
              <div className="font-medium">PDF Report</div>
              <div className="text-[11px] text-[var(--text-muted)]">Formatted for compliance review</div>
            </div>
          </button>
          <button
            role="menuitem"
            onClick={() => handleExport('csv')}
            className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors text-left"
          >
            <FileSpreadsheet size={16} className="text-[var(--text-muted)] shrink-0" />
            <div>
              <div className="font-medium">CSV Spreadsheet</div>
              <div className="text-[11px] text-[var(--text-muted)]">For data analysis & archival</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  requests: TradeRequest[];
  role: UserRole;
  onSelectRequest: (id: string) => void;
  onExport: (format: ExportFormat) => void;
  exportLoading?: boolean;
  loading?: boolean;
  error?: string | null;
  loadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onRetry?: () => void;
  queueSearchInput: string;
  onQueueSearchChange: (value: string) => void;
}

export function TradingQueue({
  requests,
  role,
  onSelectRequest,
  onExport,
  exportLoading,
  loading,
  error,
  loadingMore,
  hasMore,
  onLoadMore,
  onRetry,
  queueSearchInput,
  onQueueSearchChange,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortDir('asc');
      }
      return key;
    });
  }, []);

  const sortedRequests = useMemo(
    () => [...requests].sort((a, b) => compareBySortKey(a, b, sortKey, sortDir)),
    [requests, sortKey, sortDir],
  );

  const colCount = role === 'trader' ? 7 : 5;

  if (loading && requests.length === 0) {
    return (
      <div className="flex items-center justify-center py-20" aria-busy={true}>
        <div className="text-[var(--text-muted)] text-sm" role="status" aria-live="polite">
          Loading requests...
        </div>
      </div>
    );
  }

  if (error && requests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="text-[var(--red)] text-sm" role="alert">
          {error}
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="px-4 py-2 text-sm font-medium bg-[var(--bg-pill)] text-white rounded-lg hover:bg-[var(--bg-pill-hover)] transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const queueContent = (
    <div className="max-w-7xl mx-auto space-y-6" aria-busy={loading === true}>
      <div className="flex justify-between items-center">
        <h2 className="font-serif text-[22px] font-medium text-[var(--text-primary)]">Global Trading Queue</h2>
        <ExportDropdown onExport={onExport} exportLoading={exportLoading} />
      </div>

      <div className="relative">
        <Search
          size={16}
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
        />
        <input
          type="search"
          value={queueSearchInput}
          onChange={(e) => onQueueSearchChange(e.target.value)}
          placeholder="Search all requests (ID, client, type, advisor, submitter, status)…"
          aria-label="Search trade requests"
          className="w-full pl-10 pr-4 py-2.5 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--text-muted)] transition-colors"
        />
      </div>

      {error && requests.length > 0 && (
        <div
          className="bg-[var(--red-light)] border border-[var(--red-border)] rounded-lg px-4 py-2.5 flex items-center justify-between"
          role="alert"
        >
          <span className="text-[13px] text-[var(--red)]">Unable to refresh — showing last loaded data.</span>
          {onRetry && (
            <button
              onClick={onRetry}
              className="text-[13px] font-medium text-[var(--red)] underline hover:no-underline ml-3"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <div className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] overflow-hidden overflow-x-auto">
        <table className="w-full text-left text-[13px] min-w-[720px]">
          <caption className="sr-only">All trade requests across advisors</caption>
          <thead>
            <tr className="bg-[var(--bg-surface)]">
              {(
                [
                  { key: 'id' as SortKey, label: 'Request ID' },
                  { key: 'household' as SortKey, label: 'Household' },
                  { key: 'tradeType' as SortKey, label: 'Trade Type' },
                  { key: 'date' as SortKey, label: 'Date' },
                  ...(role === 'trader'
                    ? [
                        { key: 'advisor' as SortKey, label: 'Advisor' },
                        { key: 'submittedBy' as SortKey, label: 'Submitted by' },
                      ]
                    : []),
                  { key: 'status' as SortKey, label: 'Status' },
                ] as const
              ).map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  onClick={() => handleSort(col.key)}
                  className="px-6 py-3 text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border)] cursor-pointer select-none hover:text-[var(--text-secondary)] transition-colors"
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    <SortIcon sortKey={sortKey} columnKey={col.key} sortDir={sortDir} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRequests.map((req) => (
              <RequestRow key={req.id} request={req} role={role} onSelect={onSelectRequest} />
            ))}
            {sortedRequests.length === 0 && (
              <tr>
                <td colSpan={colCount} className="text-center py-8 text-[var(--text-muted)]">
                  {queueSearchInput.trim() ? 'No requests match your search.' : 'No active trade requests found.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="flex justify-center pt-6" aria-live="polite" aria-busy={loadingMore === true}>
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="px-6 py-2.5 text-sm font-medium bg-[var(--bg-card)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-surface)] transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );

  return queueContent;
}

const HEX_CHARS = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

async function hashAuditChain(entries: TradeRequest['auditLog']): Promise<string> {
  if (entries.length === 0) return 'EMPTY';
  const encoder = new TextEncoder();
  let prevHash = '';
  for (const entry of entries) {
    const payload = `${prevHash}|${entry.date}|${entry.user}|${entry.action}|${entry.notes}`;
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(payload));
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += HEX_CHARS[bytes[i]];
    prevHash = hex;
  }
  return prevHash;
}

function extractActor(auditLog: TradeRequest['auditLog'], actionPattern: RegExp): string {
  const entry = auditLog.find((l) => actionPattern.test(l.action));
  return entry ? `${entry.user} (${entry.date})` : '';
}

interface ExportIdentity {
  name: string;
  email: string;
}

function csvNormalize(text: string): string {
  return text
    .replace(/\r\n/g, ' ')
    .replace(/[\r\n]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const MAX_STRATEGY_COLS = 3;

export async function exportComplianceReport(
  requests: TradeRequest[],
  exporter: ExportIdentity,
  standingExclusionsByClient: Record<string, ClientExclusion[]> = {},
  accountExclusionsByRequestId: Record<string, ExportAccountExclusion[]> = {},
): Promise<void> {
  const exportTimestamp = new Date().toISOString();
  const rows: string[] = [];

  rows.push(
    `# Report Exported By: ${exporter.name} (${exporter.email}) | Exported At: ${exportTimestamp} | Record Count: ${requests.length}`,
  );

  const stratHeaders: string[] = [];
  for (let i = 1; i <= MAX_STRATEGY_COLS; i++) {
    stratHeaders.push(`Strategy ${i} Benchmark`, `Strategy ${i} Allocation %`, `Strategy ${i} Rationale`);
  }

  rows.push(
    [
      'Request ID',
      'Client ID',
      'Client Name',
      'Advisor',
      'Submitted By',
      'Trade Type',
      'Trade Amount',
      'Deposit Account',
      'Status',
      'Total Value',
      'Selected Accounts',
      'Residence',
      'Liquidation Approval',
      'Advisor Exclusions',
      'Client Exclusions',
      'Standing Advisor Exclusions (current)',
      'Standing Client Exclusions (current)',
      'Standing Account Advisor Exclusions (current)',
      'Standing Account Client Exclusions (current)',
      'ESG Filters',
      'Risk Profile',
      'Base Allocation',
      ...stratHeaders,
      'Created At (ISO)',
      'Updated At (ISO)',
      'Initiated By',
      'Reviewed By',
      'Audit Trail',
      'Audit Hash',
    ].join(','),
  );

  const auditHashes = await Promise.all(requests.map((req) => hashAuditChain(req.auditLog)));

  for (let ri = 0; ri < requests.length; ri++) {
    const req = requests[ri];
    const esg =
      Object.entries(req.esgFilters ?? {})
        .filter(([k, v]) => v && k !== 'none')
        .map(([k]) => k)
        .join('; ') || 'None';
    const baseAllocStr = req.baseAllocation
      ? `Eq: ${req.baseAllocation.equity}% | Fix: ${req.baseAllocation.fixed}% | Csh: ${req.baseAllocation.cash}%`
      : 'N/A';

    const stratCells: string[] = [];
    const strategies = req.equityStrategies ?? [];
    for (let i = 0; i < MAX_STRATEGY_COLS; i++) {
      if (i < strategies.length) {
        stratCells.push(
          csvEscape(strategies[i].benchmark),
          csvEscape(String(strategies[i].allocation)),
          csvEscape(csvNormalize(strategies[i].rationale)),
        );
      } else {
        stratCells.push(csvEscape(''), csvEscape(''), csvEscape(''));
      }
    }

    const auditStr = req.auditLog.map((l) => `[${l.date}] ${l.user} (${l.action}): ${l.notes}`).join(' || ');
    const auditHash = auditHashes[ri];
    const initiatedBy = extractActor(req.auditLog, /^(Created|Submitted)/i);
    const reviewedBy = extractActor(req.auditLog, /^Status changed to (Approved|Rejected)/i);
    const createdAt = new Date(req.date).toISOString();
    const updatedAt = new Date(req.updatedAt).toISOString();

    rows.push(
      [
        csvEscape(req.id),
        csvEscape(req.clientId),
        csvEscape(req.clientNames?.length > 1 ? req.clientNames.join(' & ') : req.clientName),
        csvEscape(req.advisor),
        csvEscape(getSubmitter(req)),
        csvEscape(req.tradeType),
        csvEscape(req.tradeAmount || 'N/A'),
        csvEscape(req.depositAccount || 'N/A'),
        csvEscape(req.status),
        csvEscape(String(req.totalValue)),
        csvEscape(req.selectedAccounts.join('; ')),
        csvEscape(req.residence),
        csvEscape(req.liquidationApproval || 'N/A'),
        csvEscape(req.advisorExclusions || ''),
        csvEscape(req.clientExclusions || ''),
        csvEscape(formatStandingForCsv(standingExclusionsByClient[req.clientId], 'advisor')),
        csvEscape(formatStandingForCsv(standingExclusionsByClient[req.clientId], 'client')),
        csvEscape(formatAccountStandingForCsv(accountExclusionsByRequestId[req.id], 'advisor')),
        csvEscape(formatAccountStandingForCsv(accountExclusionsByRequestId[req.id], 'client')),
        csvEscape(esg),
        csvEscape(String(req.riskProfile ?? 'N/A')),
        csvEscape(baseAllocStr),
        ...stratCells,
        csvEscape(createdAt),
        csvEscape(updatedAt),
        csvEscape(initiatedBy),
        csvEscape(reviewedBy),
        csvEscape(auditStr),
        csvEscape(auditHash),
      ].join(','),
    );
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Compliance_Export_${exportTimestamp.split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
