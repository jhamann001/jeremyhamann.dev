import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, History, Copy, Loader2, Download, ListChecks, Check } from 'lucide-react';
import type {
  TradeRequest,
  UserRole,
  Client,
  RequestStatus,
  Account,
  PreapprovalChecklist,
  ChecklistItemKey,
} from '@trade-request/shared';
import { PREAPPROVAL_CHECKLIST_ITEMS } from '@trade-request/shared';
import { formatCurrency } from '../utils/format';
import { AuditTrail } from './AuditTrail';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  fetchBulkAccountExclusions,
  fetchRequestChecklist,
  updateRequestChecklistItem,
  extractApiError,
} from '../api/client';
import { Tooltip } from './ui/Tooltip';

type ModalAction = 'approve' | 'reject' | 'needsInfo' | 'liquidation' | null;
const ACTION_STATUS_MAP: Record<NonNullable<ModalAction>, RequestStatus> = {
  approve: 'Approved',
  reject: 'Rejected',
  needsInfo: 'Needs Info',
  liquidation: 'Pending Current Asset Liquidation',
};

const ESG_LABELS: Record<string, string> = {
  fossilFuels: 'Fossil Fuels',
  tobacco: 'Tobacco',
  weapons: 'Weapons',
  alcohol: 'Alcohol',
  gambling: 'Gambling',
  other: 'Other',
};

interface ExportIdentity {
  name: string;
  email: string;
}

interface Props {
  request: TradeRequest;
  role: UserRole;
  clientMap: Record<string, Client>;
  identity: ExportIdentity;
  onClose: () => void;
  onStatusChange: (id: string, status: RequestStatus, note: string) => void | Promise<void>;
  onEdit: (id: string) => void;
  onClone: (id: string) => void;
}

export function RequestModal({ request, role, clientMap, identity, onClose, onStatusChange, onEdit, onClone }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [actionNote, setActionNote] = useState('');
  const [showActionForm, setShowActionForm] = useState<ModalAction>(null);
  const [activeTab, setActiveTab] = useState<'plan' | 'audit' | 'checklist'>('plan');
  const [checklist, setChecklist] = useState<PreapprovalChecklist>({});
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const stableClose = useCallback(() => onCloseRef.current(), []);

  // An item is complete when its box is checked. Text fields (template name,
  // transition model, tickers) are capture-only — they don't gate the count.
  const isItemComplete = useCallback((key: ChecklistItemKey): boolean => !!checklist[key]?.checked, [checklist]);
  const incompleteCount = PREAPPROVAL_CHECKLIST_ITEMS.filter((i) => !isItemComplete(i.key)).length;

  // Load persisted checklist when the modal opens.
  useEffect(() => {
    let alive = true;
    fetchRequestChecklist(request.id)
      .then((c) => {
        if (alive) setChecklist(c);
      })
      .catch(() => {
        /* non-fatal — modal still works without the checklist */
      });
    return () => {
      alive = false;
    };
  }, [request.id]);

  // Optimistic local update is the source of truth for the session; the PUT
  // persists + stamps who/when server-side (re-read on next open).
  const persistChecklistItem = useCallback(
    (key: ChecklistItemKey, checked: boolean, value: string) => {
      setChecklist((prev) => ({ ...prev, [key]: { ...prev[key], checked, value } }));
      updateRequestChecklistItem(request.id, { key, checked, value }).catch(() => {
        /* keep the optimistic value; a reload re-syncs */
      });
    },
    [request.id],
  );

  useFocusTrap(modalRef);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') stableClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [stableClose]);

  // Memoized so the derived account arrays are stable across renders (consumed
  // by `selectedAccounts` below and the PDF export).
  const resolvedClientIds = useMemo(
    () => (request.clientIds?.length ? request.clientIds : [request.clientId]),
    [request.clientIds, request.clientId],
  );
  const resolvedClients = useMemo(
    () => resolvedClientIds.map((id) => clientMap[id]).filter(Boolean),
    [resolvedClientIds, clientMap],
  );

  const fallbackAccounts: Account[] = useMemo(() => {
    if (resolvedClients.length > 0) return [];
    return (request.accountMetadata ?? [])
      .filter((a) => request.selectedAccounts.includes(a.accountNumber))
      .map((a) => ({
        id: a.accountNumber,
        clientId: request.clientId,
        accountNumber: a.accountNumber,
        accountType: a.accountType,
        balance: a.balance,
        holdings: { cash: a.balance, fixed: 0, equity: 0 },
      }));
  }, [resolvedClients.length, request.accountMetadata, request.selectedAccounts, request.clientId]);

  const selectedAccounts =
    resolvedClients.length > 0
      ? resolvedClients
          .flatMap((c) => c.accounts ?? [])
          .filter((a) => request.selectedAccounts.includes(a.accountNumber))
      : fallbackAccounts;

  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const handleAction = async () => {
    if (!showActionForm || actionLoading) return;
    setActionLoading(true);
    setActionError(null);
    try {
      await onStatusChange(request.id, ACTION_STATUS_MAP[showActionForm], actionNote);
      stableClose();
    } catch (err: unknown) {
      setActionError(extractApiError(err, 'Action failed. Please try again.'));
    } finally {
      setActionLoading(false);
    }
  };
  const handleDownloadPdf = async () => {
    setActionError(null);
    try {
      const { exportRequestPdf } = await import('../utils/pdfExport');
      const accountIds = [...new Set(selectedAccounts.map((account) => account.id).filter(Boolean))];
      const accountNumberById = new Map(selectedAccounts.map((account) => [account.id, account.accountNumber]));
      const accountExclusionsById = accountIds.length > 0 ? await fetchBulkAccountExclusions(accountIds) : {};
      const accountExclusionsForExport = accountIds.flatMap((accountId) => {
        const accountNumber = accountNumberById.get(accountId);
        if (!accountNumber) return [];
        return (accountExclusionsById[accountId] ?? []).map((exclusion) => ({
          accountNumber,
          kind: exclusion.kind,
          ticker: exclusion.ticker,
          reason: exclusion.reason,
          noBuy: exclusion.noBuy,
          noSell: exclusion.noSell,
        }));
      });
      await exportRequestPdf(request, identity, accountExclusionsForExport);
    } catch (err: unknown) {
      setActionError(extractApiError(err, 'PDF export failed. Please try again.'));
    }
  };

  const canTraderAct = role === 'trader' && !['Completed', 'Approved', 'Rejected'].includes(request.status);
  const hasAllocation = request.riskProfile != null;
  const activeEsgFilters = Object.entries(request.esgFilters ?? {})
    .filter(([k, v]) => v && k !== 'none' && k !== 'otherDescription')
    .map(([k]) => {
      if (k === 'other' && request.esgFilters?.otherDescription) {
        return `${ESG_LABELS[k]}: ${request.esgFilters.otherDescription}`;
      }
      return ESG_LABELS[k] || k;
    });

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={stableClose} />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex justify-between items-center px-7 py-5 border-b border-[var(--border)]">
          <h2 id="modal-title" className="font-serif text-xl font-medium text-[var(--text-primary)]">
            {request.clientName}{' '}
            <span className="text-[var(--text-muted)] font-sans font-normal text-sm">({request.id})</span>
          </h2>
          <div className="flex items-center gap-2">
            <Tooltip content="Download as PDF" position="bottom">
              <button
                type="button"
                onClick={handleDownloadPdf}
                aria-label="Download PDF"
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <Download size={18} />
              </button>
            </Tooltip>
            <button
              type="button"
              onClick={stableClose}
              aria-label="Close"
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Pill Tabs */}
        <div className="px-7 py-2 border-b border-[var(--border)]">
          <div
            className="flex bg-[var(--bg-surface)] rounded-full p-[3px] gap-0.5 w-fit"
            role="tablist"
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                setActiveTab(activeTab === 'plan' ? 'audit' : 'plan');
              }
            }}
          >
            <button
              type="button"
              onClick={() => setActiveTab('plan')}
              aria-selected={activeTab === 'plan'}
              aria-controls="tabpanel-plan"
              role="tab"
              tabIndex={activeTab === 'plan' ? 0 : -1}
              className={`px-4 py-1.5 text-[13px] font-medium rounded-full transition-colors ${activeTab === 'plan' ? 'bg-[var(--bg-pill)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
              Request Details
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('audit')}
              aria-selected={activeTab === 'audit'}
              aria-controls="tabpanel-audit"
              role="tab"
              tabIndex={activeTab === 'audit' ? 0 : -1}
              className={`px-4 py-1.5 text-[13px] font-medium rounded-full transition-colors flex items-center gap-1.5 ${activeTab === 'audit' ? 'bg-[var(--bg-pill)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
              <History size={14} /> Audit Trail
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('checklist')}
              aria-selected={activeTab === 'checklist'}
              aria-controls="tabpanel-checklist"
              role="tab"
              tabIndex={activeTab === 'checklist' ? 0 : -1}
              className={`px-4 py-1.5 text-[13px] font-medium rounded-full transition-colors flex items-center gap-1.5 ${activeTab === 'checklist' ? 'bg-[var(--bg-pill)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
            >
              <ListChecks size={14} /> Pre-approval Checklist
              {incompleteCount > 0 && (
                <span className="ml-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--yellow-light)] text-[var(--yellow)]">
                  {incompleteCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-7 overflow-y-auto flex-1 space-y-6">
          {request.status === 'Rejected' && (
            <div
              className="bg-[var(--red-light)] border border-[#e8c4c4] rounded-lg p-3 flex items-start gap-3"
              role="alert"
            >
              <AlertCircle className="text-[var(--red)] shrink-0 mt-0.5" size={16} />
              <div>
                <h4 className="text-sm font-bold text-[var(--red)]">Request Rejected and Locked</h4>
                <p className="text-xs text-[var(--red)] mt-1 opacity-70">
                  For SEC compliance, this record is permanently locked. The advisor must submit a new request.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'plan' && (
            <div id="tabpanel-plan" role="tabpanel">
              {/* ── 1. Status & Overview ── */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-5 bg-[var(--bg-surface)] rounded-[10px]">
                <SummaryCell label="Status" value={request.status} />
                <SummaryCell label="Trade Type" value={request.tradeType} />
                <SummaryCell label="Priority" value={request.priority || 'N/A'} />
                <SummaryCell label="Submitted" value={new Date(request.date).toLocaleDateString()} />
                <SummaryCell label="Advisor" value={request.advisor} />
                <SummaryCell label="Submitted by" value={request.submittedBy || request.advisor} />
              </div>

              {/* ── 2. Client & Accounts ── */}
              <Section title="Client & Accounts">
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <ReadonlyField
                    label={request.clientIds?.length > 1 ? 'Clients (Household)' : 'Client'}
                    value={request.clientNames?.length > 1 ? request.clientNames.join(' & ') : request.clientName}
                  />
                  <ReadonlyField label="Trade Type" value={request.tradeType} />
                </div>

                {selectedAccounts.length > 0 && (
                  <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-[10px] p-4">
                    <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
                      Selected Accounts
                    </p>
                    <div className="space-y-2">
                      {selectedAccounts.map((acc) => (
                        <div
                          key={acc.accountNumber}
                          className="flex items-center justify-between p-3 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]"
                        >
                          <div className="flex items-center gap-3">
                            <div>
                              <p className="text-sm font-bold font-mono text-[var(--text-primary)]">
                                {acc.accountNumber}
                              </p>
                              <p className="text-xs text-[var(--text-muted)]">
                                {acc.accountType} · <span className="font-mono">ID: {acc.id}</span>
                              </p>
                            </div>
                          </div>
                          <span className="text-sm text-[var(--green)] font-mono font-bold">
                            {formatCurrency(acc.balance)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 pt-3 border-t border-[var(--border)] flex justify-between text-sm">
                      <span className="text-[var(--text-muted)] font-medium">Total Value</span>
                      <span className="font-mono font-bold text-[var(--text-primary)]">
                        {formatCurrency(request.totalValue)}
                      </span>
                    </div>
                  </div>
                )}

                {(request.tradeAmount || request.depositAccount) && (
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    {request.tradeAmount && (
                      <ReadonlyField
                        label={request.tradeType === 'Cash Deposit' ? 'Deposit Amount' : 'Trade Amount / Instructions'}
                        value={request.tradeAmount}
                      />
                    )}
                    {request.depositAccount && (
                      <ReadonlyField label="Deposit Into Account" value={request.depositAccount} mono />
                    )}
                  </div>
                )}
                {request.tradeType === 'Cash Deposit' && (
                  <div className="mt-4">
                    <ReadonlyField
                      label="Rebalance All Accounts"
                      value={
                        request.rebalanceAll
                          ? 'Yes — all selected accounts will be rebalanced to target'
                          : 'No — only the deposit account will be traded'
                      }
                    />
                  </div>
                )}
              </Section>

              {/* ── 3. Mandate & Base Allocation ── */}
              {hasAllocation && request.baseAllocation && (
                <Section title="Mandate & Base Allocation">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div>
                      <ReadonlyField label="Client Risk Score" value={`Level ${request.riskProfile} / 25`} />
                    </div>
                    <div className="md:col-span-2">
                      <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                        Resulting Base Allocation
                      </p>
                      <div className="grid grid-cols-3 gap-2">
                        {(['equity', 'fixed', 'cash'] as const).map((key) => (
                          <div
                            key={key}
                            className="bg-[var(--bg-surface)] border border-[var(--border)] p-3 rounded-lg text-center"
                          >
                            <p className="text-[10px] text-[var(--text-muted)] uppercase">
                              {key === 'fixed' ? 'Fixed Inc.' : key.charAt(0).toUpperCase() + key.slice(1)}
                            </p>
                            <p className="font-serif font-medium text-lg text-[var(--text-primary)]">
                              {request.baseAllocation[key]}%
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </Section>
              )}

              {/* ── 4. Equity Strategies ── */}
              {hasAllocation && (request.equityStrategies ?? []).length > 0 && (
                <Section title="Equity Strategy Construction">
                  <div className="space-y-2">
                    {(request.equityStrategies ?? []).map((strat) => (
                      <div
                        key={strat.id}
                        className="bg-[var(--bg-surface)] p-4 rounded-[10px] border border-[var(--border)]"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-semibold text-[var(--text-primary)]">{strat.benchmark}</span>
                          <span className="font-bold text-xs font-mono bg-[var(--bg-card)] text-[var(--text-primary)] px-2.5 py-0.5 rounded border border-[var(--border)]">
                            {strat.allocation}%
                          </span>
                        </div>
                        <p className="text-xs text-[var(--text-secondary)] italic leading-relaxed">
                          "{strat.rationale}"
                        </p>
                      </div>
                    ))}
                    <div className="flex justify-end">
                      <span
                        className={`text-xs font-mono font-bold px-3 py-1 rounded-md ${
                          (request.equityStrategies ?? []).reduce((s, st) => s + st.allocation, 0) === 100
                            ? 'bg-[var(--green-light)] text-[var(--green)]'
                            : 'bg-[var(--red-light)] text-[var(--red)]'
                        }`}
                      >
                        {(request.equityStrategies ?? []).reduce((s, st) => s + st.allocation, 0)}% / 100%
                      </span>
                    </div>
                  </div>
                </Section>
              )}

              {/* ── Raise Cash Details ── */}
              {request.tradeType === 'Raise Cash' && (
                <Section title="Cash Raise Details">
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <ReadonlyField label="Cash Amount to Raise" value={request.tradeAmount || 'N/A'} />
                    <ReadonlyField
                      label="Liquidity Deadline"
                      value={
                        request.liquidityDeadline
                          ? new Date(request.liquidityDeadline).toLocaleDateString()
                          : 'Not specified'
                      }
                    />
                  </div>
                  {request.raiseCashReason && (
                    <ReadonlyField label="Reason for Cash Raise" value={request.raiseCashReason} />
                  )}
                </Section>
              )}

              {/* ── Liquidate Details ── */}
              {request.tradeType === 'Liquidate' && (
                <Section title="Liquidation Details">
                  <div className="grid grid-cols-2 gap-4">
                    <ReadonlyField label="Liquidation Option" value={request.liquidateOption || 'N/A'} />
                    {request.liquidateOption === 'Specific Positions' && request.liquidatePositions && (
                      <ReadonlyField label="Positions to Liquidate" value={request.liquidatePositions} />
                    )}
                  </div>
                </Section>
              )}

              {/* ── 5. Compliance, Exclusions & ESG (full form types only) ── */}
              {hasAllocation && (
                <Section title="Compliance, Exclusions & Execution">
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <ReadonlyField
                      label="State Residence"
                      value={
                        request.residence === 'NY'
                          ? 'New York (NY) - Muni Preference'
                          : request.residence === 'CA'
                            ? 'California (CA) - Muni Preference'
                            : 'Other / Not Applicable'
                      }
                    />
                    <ReadonlyField label="Liquidation Approval" value={request.liquidationApproval || 'N/A'} />
                  </div>

                  <div className="mb-4">
                    <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                      ESG Filters
                    </p>
                    {activeEsgFilters.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {activeEsgFilters.map((f) => (
                          <span
                            key={f}
                            className="px-3 py-1 bg-[var(--bg-surface)] border border-[var(--border)] rounded-full text-xs font-medium text-[var(--text-primary)]"
                          >
                            {f}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-[var(--text-muted)]">None applied</span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                        Advisor Exclusions
                      </p>
                      {request.advisorExclusions ? (
                        <p className="text-sm text-[var(--red)] font-semibold bg-[var(--red-light)] px-3 py-2 rounded-lg">
                          {request.advisorExclusions}
                        </p>
                      ) : (
                        <p className="text-sm text-[var(--text-muted)]">None</p>
                      )}
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                        Client Exclusions
                      </p>
                      {request.clientExclusions ? (
                        <p className="text-sm text-[var(--red)] font-semibold bg-[var(--red-light)] px-3 py-2 rounded-lg">
                          {request.clientExclusions}
                        </p>
                      ) : (
                        <p className="text-sm text-[var(--text-muted)]">None</p>
                      )}
                    </div>
                  </div>
                </Section>
              )}

              {/* ── Advisor Notes ── */}
              {request.advisorNotes && (
                <Section title="Workflow & Advisor Notes">
                  <ReadonlyField label="Advisor Compliance & Execution Notes" value={request.advisorNotes} />
                </Section>
              )}
            </div>
          )}

          {activeTab === 'audit' && (
            <div id="tabpanel-audit" role="tabpanel">
              <AuditTrail entries={request.auditLog} />
            </div>
          )}

          {activeTab === 'checklist' && (
            <div id="tabpanel-checklist" role="tabpanel" className="space-y-4">
              <div className="flex items-end justify-between gap-3">
                <p className="text-sm text-[var(--text-secondary)]">
                  <span className="font-bold text-[var(--text-primary)]">Pre-approval checklist</span> — confirm before
                  you approve &amp; execute.
                </p>
                <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">
                  {PREAPPROVAL_CHECKLIST_ITEMS.length - incompleteCount} of {PREAPPROVAL_CHECKLIST_ITEMS.length}{' '}
                  complete
                </span>
              </div>
              <div className="h-1.5 bg-[var(--bg-surface)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--green)] rounded-full transition-all"
                  style={{
                    width: `${Math.round(((PREAPPROVAL_CHECKLIST_ITEMS.length - incompleteCount) / PREAPPROVAL_CHECKLIST_ITEMS.length) * 100)}%`,
                  }}
                />
              </div>
              <div className="divide-y divide-[var(--border)]">
                {PREAPPROVAL_CHECKLIST_ITEMS.map((item) => {
                  const st = checklist[item.key];
                  const checked = !!st?.checked;
                  const value = st?.value ?? '';
                  const editable = canTraderAct;
                  return (
                    <div key={item.key} className="flex gap-3 py-3">
                      <button
                        type="button"
                        disabled={!editable}
                        onClick={() => editable && persistChecklistItem(item.key, !checked, value)}
                        aria-pressed={checked}
                        aria-label={item.label}
                        className={`mt-0.5 flex-none w-5 h-5 rounded-[6px] border flex items-center justify-center transition-colors ${checked ? 'bg-[var(--green)] border-[var(--green)] text-white' : 'border-[var(--border)] bg-transparent'} ${editable ? 'cursor-pointer hover:border-[var(--text-muted)]' : 'cursor-default'}`}
                      >
                        {checked && <Check size={12} strokeWidth={3} />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-[var(--text-primary)]">{item.label}</div>
                        {item.help && (
                          <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-snug">{item.help}</div>
                        )}
                        {item.hasField && (checked || value) && (
                          <div className="mt-2">
                            <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
                              {item.fieldLabel}
                            </div>
                            <textarea
                              value={value}
                              disabled={!editable}
                              rows={2}
                              placeholder={item.fieldPlaceholder}
                              onChange={(e) =>
                                setChecklist((prev) => ({
                                  ...prev,
                                  [item.key]: {
                                    ...prev[item.key],
                                    checked: prev[item.key]?.checked ?? true,
                                    value: e.target.value,
                                  },
                                }))
                              }
                              onBlur={(e) => editable && persistChecklistItem(item.key, checked, e.target.value)}
                              className="w-full min-h-[38px] resize-y bg-[var(--bg-input)] border border-[var(--border)] rounded-lg p-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-muted)] disabled:opacity-70"
                            />
                          </div>
                        )}
                        {st?.by && st?.at && (
                          <div className="text-[11px] text-[var(--text-muted)] mt-1">
                            Checked by {st.by} · {new Date(st.at).toLocaleDateString()}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {!canTraderAct && (
                <p className="text-xs text-[var(--text-muted)]">
                  {role !== 'trader'
                    ? 'Read-only — only traders can update the checklist.'
                    : 'This request is closed; the checklist is locked.'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-7 py-4 border-t border-[var(--border)] space-y-2">
          {actionError && (
            <div className="bg-[var(--red-light)] border border-[var(--red-border)] rounded-lg px-3 py-2 text-[13px] text-[var(--red)] flex items-center gap-2">
              <AlertCircle size={14} /> {actionError}
            </div>
          )}
          {showActionForm ? (
            <div className="space-y-3">
              {showActionForm === 'approve' && incompleteCount > 0 && (
                <div className="bg-[var(--yellow-light)] border border-[var(--yellow-border)] rounded-lg px-3 py-2 text-[13px] text-[var(--yellow)] flex items-start gap-2">
                  <AlertCircle size={14} className="mt-0.5 flex-none" />
                  <span>
                    {incompleteCount} checklist {incompleteCount === 1 ? 'item is' : 'items are'} still unchecked. You
                    can approve anyway — confirm below — or finish the{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setShowActionForm(null);
                        setActiveTab('checklist');
                      }}
                      className="underline font-medium"
                    >
                      pre-approval checklist
                    </button>{' '}
                    first.
                  </span>
                </div>
              )}
              <label htmlFor="modal-action-note" className="text-sm font-bold text-[var(--text-primary)]">
                Add Note for Audit/Advisor:
              </label>
              <input
                id="modal-action-note"
                type="text"
                autoFocus
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                placeholder="e.g., Client needs to sign form first..."
                className="w-full bg-[var(--bg-input)] border border-[var(--border)] rounded-lg p-2.5 text-[var(--text-primary)] text-sm outline-none focus:border-[var(--text-muted)]"
              />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => {
                    setShowActionForm(null);
                    setActionError(null);
                  }}
                  disabled={actionLoading}
                  className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAction}
                  disabled={actionLoading}
                  className="px-6 py-2 bg-[var(--bg-pill)] hover:bg-[var(--bg-pill-hover)] text-white rounded-lg text-sm font-bold disabled:opacity-50 flex items-center gap-2"
                >
                  {actionLoading && <Loader2 size={14} className="animate-spin" />}
                  {actionLoading ? 'Processing...' : 'Confirm'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-between items-center">
              <button
                onClick={stableClose}
                className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Close
              </button>
              {canTraderAct && (
                <div className="flex gap-2">
                  <Tooltip content="Return to advisor for more details" position="top">
                    <button
                      onClick={() => setShowActionForm('needsInfo')}
                      className="px-4 py-2 bg-[var(--yellow-light)] text-[var(--yellow)] rounded-lg text-sm font-medium hover:brightness-95 transition"
                    >
                      Needs Info
                    </button>
                  </Tooltip>
                  <Tooltip content="Mark as pending existing asset liquidation" position="top">
                    <button
                      onClick={() => setShowActionForm('liquidation')}
                      className="px-4 py-2 bg-[var(--bg-pill)] text-white rounded-lg text-sm font-medium hover:bg-[var(--bg-pill-hover)] transition"
                    >
                      Pending Liquidation
                    </button>
                  </Tooltip>
                  <Tooltip content="Permanently reject — record will be locked" position="top">
                    <button
                      onClick={() => setShowActionForm('reject')}
                      className="px-4 py-2 bg-[var(--red-light)] text-[var(--red)] rounded-lg text-sm font-medium hover:brightness-95 transition"
                    >
                      Reject
                    </button>
                  </Tooltip>
                  <Tooltip content="Approve and send to execution" position="top">
                    <button
                      onClick={() => setShowActionForm('approve')}
                      className="px-6 py-2 bg-[var(--green)] text-white rounded-lg text-sm font-bold hover:brightness-90 transition"
                    >
                      Approve & Execute
                    </button>
                  </Tooltip>
                </div>
              )}
              {role === 'advisor' && request.status === 'Needs Info' && (
                <Tooltip content="Revise and resubmit this request for trader review" position="top">
                  <button
                    onClick={() => onEdit(request.id)}
                    className="px-6 py-2 bg-[var(--bg-pill)] hover:bg-[var(--bg-pill-hover)] text-white rounded-lg text-sm font-bold"
                  >
                    Edit & Resubmit
                  </button>
                </Tooltip>
              )}
              {role === 'advisor' && request.status === 'Rejected' && (
                <Tooltip content="Create a new request pre-filled from this one" position="top">
                  <button
                    onClick={() => onClone(request.id)}
                    className="px-6 py-2 bg-[var(--bg-pill)] hover:bg-[var(--bg-pill-hover)] text-white rounded-lg text-sm font-bold flex items-center gap-2"
                  >
                    <Copy size={16} /> Clone to New Request
                  </button>
                </Tooltip>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest border-b border-[var(--border)] pb-2 mb-4">
        {title}
      </h3>
      {children}
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-[var(--text-muted)] uppercase font-semibold tracking-wider">{label}</p>
      <p className="text-sm font-bold text-[var(--text-primary)] mt-1.5">{value}</p>
    </div>
  );
}

function ReadonlyField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">{label}</p>
      <p
        className={`text-sm font-medium text-[var(--text-primary)] bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg px-3 py-2 ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}
