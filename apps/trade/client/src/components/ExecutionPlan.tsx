import { useState } from 'react';
import { Cpu, FileText, CheckCircle2, AlertTriangle, ChevronRight } from 'lucide-react';
import type {
  TradeRequest,
  TradeType,
  UserRole,
  Holdings,
  AccountExecutionPlan,
  VarianceAnalysis,
  BaseAllocation,
  ValidationResult,
  HouseholdSiblingHolding,
} from '@trade-request/shared';
import { formatCurrency } from '../utils/format';
import { Tooltip } from './ui/Tooltip';

interface TraderHoldingsInputProps {
  request: TradeRequest;
  traderHoldings: Record<string, Holdings & { type: string }>;
  onHoldingsChange: (accNum: string, field: keyof Holdings, val: string) => void;
  householdSiblings?: HouseholdSiblingHolding[];
  driftRunDate?: string | null;
}

export function TraderHoldingsInput({
  request,
  traderHoldings,
  onHoldingsChange,
  householdSiblings = [],
  driftRunDate = null,
}: TraderHoldingsInputProps) {
  const isCashDeposit = request.tradeType === 'Cash Deposit';
  const deposit = isCashDeposit ? parseFloat(String(request.tradeAmount).replace(/[^0-9.-]+/g, '')) || 0 : 0;
  const preDepositTotal = Object.values(traderHoldings).reduce(
    (sum, h) => sum + (Number(h.cash) || 0) + (Number(h.fixed) || 0) + (Number(h.equity) || 0),
    0,
  );
  const postDepositTotal = preDepositTotal + deposit;

  // Household-wide totals. The editable rows above are the SELECTED (traded)
  // accounts only; the read-only siblings below make up the rest of the
  // household. We surface both so "Household Total" honestly covers everyone,
  // while the engine still operates on the selected subtotal.
  const hasSiblings = householdSiblings.length > 0;
  const siblingsTotal = householdSiblings.reduce((sum, s) => sum + (Number(s.balance) || 0), 0);
  const householdTotal = preDepositTotal + siblingsTotal;
  const householdAccountCount = Object.keys(traderHoldings).length + householdSiblings.length;

  return (
    <div
      id="pre-trade-holdings-inputs"
      className="bg-[var(--bg-surface)] rounded-[10px] border border-[var(--border)] p-5"
    >
      <div className="flex justify-between items-center mb-3 border-b border-[var(--border)] pb-2">
        <h3 className="text-sm font-bold text-[var(--text-primary)]">
          {isCashDeposit ? 'Current Holdings Before Deposit' : 'Household Current Holdings (Pre-Trade)'}
        </h3>
        <Tooltip
          content={
            isCashDeposit
              ? 'Enter current holdings before the new USD deposit. The deposit is shown separately below.'
              : 'The engine uses these values to compute optimal trades. Adjust if the data looks stale.'
          }
          position="bottom"
        >
          <span className="text-xs text-[var(--text-label)] cursor-help">Edit to ensure accurate holdings</span>
        </Tooltip>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-[var(--text-secondary)]">
          <thead className="text-[10px] text-[var(--text-muted)] uppercase border-b border-[var(--border)]">
            <tr>
              <th className="pb-2 font-bold">Account</th>
              <th className="pb-2 font-bold">{isCashDeposit ? 'Existing Cash/MMF ($)' : 'Cash ($)'}</th>
              <th className="pb-2 font-bold">Fixed Inc ($)</th>
              <th className="pb-2 font-bold">Equity ($)</th>
              <th className="pb-2 font-bold text-right">Total ($)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-light)]">
            {Object.entries(traderHoldings).map(([accNum, h]) => {
              const rowTotal = (Number(h.cash) || 0) + (Number(h.fixed) || 0) + (Number(h.equity) || 0);
              return (
                <tr key={accNum}>
                  <td className="py-3 font-mono text-xs text-[var(--text-primary)] font-bold">
                    {accNum}
                    {accNum === request.depositAccount && (
                      <span className="ml-2 text-[10px] bg-[var(--green-light)] text-[var(--green)] px-1.5 py-0.5 rounded">
                        Deposit
                      </span>
                    )}
                    <span className="text-[var(--text-muted)] block text-[10px] uppercase mt-0.5 font-normal">
                      {h.type}
                    </span>
                  </td>
                  {(['cash', 'fixed', 'equity'] as const).map((field) => (
                    <td key={field} className="py-2 pr-2">
                      <input
                        type="number"
                        value={h[field]}
                        onChange={(e) => onHoldingsChange(accNum, field, e.target.value)}
                        className="w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-1.5 text-[var(--text-primary)] text-xs focus:border-[#aaa] outline-none"
                      />
                    </td>
                  ))}
                  <td className="py-2 text-right font-bold text-[var(--text-primary)]">{formatCurrency(rowTotal)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-[var(--border)]">
            <tr>
              <td colSpan={4} className="pt-3 text-right text-xs font-bold text-[var(--text-muted)] uppercase">
                {hasSiblings
                  ? isCashDeposit
                    ? 'Selected Accounts (Before Deposit):'
                    : 'Selected Accounts Total:'
                  : isCashDeposit
                    ? 'Current Household Value Before Deposit:'
                    : 'Household Total:'}
              </td>
              <td className="pt-3 text-right font-bold text-[var(--text-label)] text-base">
                {formatCurrency(preDepositTotal)}
              </td>
            </tr>
            {hasSiblings && (
              <tr>
                <td colSpan={4} className="pt-2 text-right text-xs font-bold text-[var(--text-muted)] uppercase">
                  Household Total ({householdAccountCount} accounts):
                </td>
                <td className="pt-2 text-right font-bold text-[var(--text-label)] text-base">
                  {formatCurrency(householdTotal)}
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>
      {isCashDeposit && (
        <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-4">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-light)] pb-3">
            <div>
              <div className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-wider">
                New USD Deposit
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Shown separately from existing cash/MMF so it is not entered twice.
              </p>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Deposit Account</div>
              <div className="font-mono text-sm font-bold text-[var(--text-primary)]">
                {request.depositAccount || 'N/A'}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3 text-sm">
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">New USD Deposit</div>
              <div className="font-mono font-bold text-[var(--green)]">{formatCurrency(deposit)}</div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Before Deposit</div>
              <div className="font-mono font-bold text-[var(--text-primary)]">{formatCurrency(preDepositTotal)}</div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">After Deposit</div>
              <div className="font-mono font-bold text-[var(--text-primary)]">{formatCurrency(postDepositTotal)}</div>
            </div>
          </div>
        </div>
      )}
      <HouseholdSiblings siblings={householdSiblings} driftRunDate={driftRunDate} />
    </div>
  );
}

// ── Read-only context: other accounts in the household, current allocation +
// drift-vs-model from the latest nightly drift run. Collapsed by default;
// hidden entirely when the household has no other accounts. ──
const EM_DASH = '—';
const fmtPct = (v: number | null): string => (v === null ? EM_DASH : `${Math.round(v)}%`);
const BUCKET_LABEL: Record<'cash' | 'fixed' | 'equity', string> = {
  cash: 'Cash',
  fixed: 'Fixed',
  equity: 'Equity',
};

function HouseholdSiblings({
  siblings,
  driftRunDate,
}: {
  siblings: HouseholdSiblingHolding[];
  driftRunDate: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (siblings.length === 0) return null;

  const othersTotal = siblings.reduce((sum, s) => sum + (Number(s.balance) || 0), 0);

  return (
    <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]">
          <ChevronRight
            size={15}
            className={`text-[var(--text-muted)] transition-transform ${open ? 'rotate-90' : ''}`}
          />
          Other accounts in this household ({siblings.length})
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">Read-only · not traded</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-4 pb-4 pt-3">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-[var(--text-secondary)]">
              <thead className="text-[10px] uppercase text-[var(--text-muted)] border-b border-[var(--border)]">
                <tr>
                  <th className="pb-2 font-bold">Account</th>
                  <th className="pb-2 font-bold">Current (C/F/E)</th>
                  <th className="pb-2 font-bold">Target (C/F/E)</th>
                  <th className="pb-2 font-bold">Drift</th>
                  <th className="pb-2 font-bold text-right">Total ($)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-light)]">
                {siblings.map((s) => {
                  const noModel = !s.hasDrift;
                  const drift =
                    s.maxBucketDeltaPct === null
                      ? EM_DASH
                      : `${s.maxBucketDeltaPct.toFixed(1)}%${s.worstBucket ? ` ${BUCKET_LABEL[s.worstBucket]}` : ''}`;
                  return (
                    <tr key={s.accountId}>
                      <td className="py-3 align-top">
                        <span className="block font-mono text-xs font-bold text-[var(--text-primary)]">
                          {s.accountNumber ?? s.accountId}
                        </span>
                        <span className="block text-[10px] text-[var(--text-muted)]">
                          {s.accountTitle}
                          {s.accountType ? ` · ${s.accountType}` : ''}
                        </span>
                        {noModel && (
                          <span className="mt-0.5 inline-block text-[10px] text-[var(--text-muted)] italic">
                            no model data
                          </span>
                        )}
                      </td>
                      <td className="py-3 font-mono text-xs">
                        {noModel
                          ? EM_DASH
                          : `${fmtPct(s.positionCashPct)} / ${fmtPct(s.positionFixedPct)} / ${fmtPct(s.positionEquityPct)}`}
                      </td>
                      <td className="py-3 font-mono text-xs">
                        {s.templateCashPct === null && s.templateFixedPct === null && s.templateEquityPct === null
                          ? EM_DASH
                          : `${fmtPct(s.templateCashPct)} / ${fmtPct(s.templateFixedPct)} / ${fmtPct(s.templateEquityPct)}`}
                      </td>
                      <td className="py-3 font-mono text-xs">{drift}</td>
                      <td className="py-3 text-right font-bold text-[var(--text-primary)]">
                        {formatCurrency(s.balance)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-[var(--border)]">
                <tr>
                  <td colSpan={4} className="pt-3 text-right text-xs font-bold text-[var(--text-muted)] uppercase">
                    Other accounts total:
                  </td>
                  <td className="pt-3 text-right font-bold text-[var(--text-primary)]">
                    {formatCurrency(othersTotal)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-[11px] text-[var(--text-muted)]">
            Allocation shown as cash / fixed income / equity.{' '}
            {driftRunDate
              ? `Current allocation as of ${driftRunDate} (drift snapshot).`
              : 'Drift snapshot unavailable.'}
          </p>
        </div>
      )}
    </div>
  );
}

interface ExecutionPlanViewProps {
  request: TradeRequest;
  role: UserRole;
  computingId: string | null;
  onRunEngine: () => void;
}

export function ExecutionPlanView({ request, role, computingId, onRunEngine }: ExecutionPlanViewProps) {
  const isComputing = computingId === request.id;
  const isTerminal = ['Approved', 'Rejected'].includes(request.status);
  const canRunEngine =
    role === 'trader' && ['Initial Funding', 'Rebalance', 'Cash Deposit'].includes(request.tradeType);
  const plans = request.executionPlan ?? [];

  return (
    <div>
      <h3 className="text-sm font-bold text-[var(--text-primary)] mb-3 flex items-center justify-between mt-4">
        <span className="flex items-center gap-2">
          <Cpu size={16} className="text-[var(--text-label)]" />
          {request.riskProfile ? '3. Execution Plan' : '1. Execution Plan'}
          {plans.length > 0 && request.validation && <ValidationBadge validation={request.validation} />}
        </span>
        {canRunEngine && (
          <Tooltip
            content={isTerminal ? 'Engine cannot run on finalized requests' : 'Compute optimal trades'}
            position="bottom"
          >
            <button
              disabled={isComputing || isTerminal}
              onClick={onRunEngine}
              className="flex items-center gap-2 bg-[var(--bg-pill)] hover:bg-[var(--bg-pill-hover)] text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            >
              <Cpu size={14} className={isComputing ? 'animate-spin' : ''} />
              {isComputing ? 'Computing...' : plans.length > 0 ? 'Re-Run Engine' : 'Run Engine'}
            </button>
          </Tooltip>
        )}
      </h3>
      <div className="space-y-4">
        {plans.length === 0 ? (
          <EmptyPlanState isComputing={isComputing} isTrader={role === 'trader'} tradeType={request.tradeType} />
        ) : (
          <>
            {plans.map((plan, idx) => (
              <AccountPlanCard key={idx} plan={plan} />
            ))}
            {request.baseAllocation && (
              <HouseholdVarianceSummary plans={plans} baseAllocation={request.baseAllocation} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ValidationBadge({ validation }: { validation: ValidationResult }) {
  if (validation.passed) {
    return (
      <Tooltip content="Allocation reconciles to target within $1 tolerance." position="bottom">
        <span className="inline-flex items-center gap-1 text-[var(--green)] cursor-help">
          <CheckCircle2 size={14} />
        </span>
      </Tooltip>
    );
  }
  const tooltipContent = validation.issues.map((i) => i.message).join('\n');
  return (
    <Tooltip content={tooltipContent} position="bottom">
      <span className="inline-flex items-center gap-1 text-[var(--red)] cursor-help">
        <AlertTriangle size={14} />
      </span>
    </Tooltip>
  );
}

function EmptyPlanState({
  isComputing,
  isTrader,
  tradeType,
}: {
  isComputing: boolean;
  isTrader: boolean;
  tradeType: TradeType;
}) {
  if (isComputing) {
    return (
      <div className="p-8 bg-[var(--bg-surface)] border border-[var(--border)] border-dashed rounded-[10px] text-center flex flex-col items-center gap-3">
        <Cpu size={32} className="text-[var(--text-label)] animate-pulse" />
        <div>
          <p className="text-[var(--text-primary)] font-medium">Computing optimal rebalance & tax placement...</p>
          <p className="text-sm text-[var(--text-muted)] mt-1">Analyzing current holdings against new targets...</p>
        </div>
      </div>
    );
  }
  return (
    <div className="p-8 bg-[var(--bg-surface)] border border-[var(--border)] border-dashed rounded-[10px] text-center flex flex-col items-center gap-3">
      <FileText size={32} className="text-[var(--text-muted)]" />
      <div>
        <p className="text-[var(--text-secondary)] font-medium">No execution plan generated yet.</p>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          {isTrader ? "Click 'Run Engine' above to generate." : 'Pending trader review.'}
        </p>
        {isTrader && tradeType === 'Cash Deposit' && (
          <p className="text-sm text-[var(--text-muted)] mt-2 max-w-md mx-auto">
            Cash deposits are not pre-planned on submit. Confirm household holdings in the table above, then run the
            engine.
          </p>
        )}
      </div>
    </div>
  );
}

function AccountPlanCard({ plan }: { plan: AccountExecutionPlan }) {
  const hasDepositContext = Boolean(plan.cashDepositContext);

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-[10px] overflow-hidden">
      <div className="bg-[var(--bg-surface)] px-5 py-3 border-b border-[var(--border)] flex justify-between items-center">
        <div>
          <span className="font-mono text-[var(--text-primary)] text-sm font-bold">{plan.accountNumber}</span>
          <span className="text-[10px] text-[var(--text-muted)] ml-2 bg-[var(--bg-card)] px-2 py-0.5 rounded border border-[var(--border)] uppercase font-semibold">
            {plan.accountType}
          </span>
          {plan.modelName && (
            <span className="text-[10px] text-[var(--text-label)] ml-2 bg-[var(--bg-card)] px-2 py-0.5 rounded border border-[var(--border)] font-semibold">
              {plan.modelName}
            </span>
          )}
        </div>
        <div className="text-sm font-bold text-[var(--text-primary)] text-right">
          {formatCurrency(plan.accountValue)}
          {plan.postTradeHoldings && plan.accountValue > 0 && (
            <div className="text-[10px] text-[var(--text-muted)] mt-0.5 font-normal">
              Final &rarr; Eq:{' '}
              <span className="font-bold text-[var(--text-primary)]">
                {((plan.postTradeHoldings.equity / plan.accountValue) * 100).toFixed(2)}%
              </span>{' '}
              ({formatCurrency(plan.postTradeHoldings.equity)}){' | '}Fix:{' '}
              <span className="font-bold text-[var(--text-primary)]">
                {((plan.postTradeHoldings.fixed / plan.accountValue) * 100).toFixed(2)}%
              </span>{' '}
              ({formatCurrency(plan.postTradeHoldings.fixed)}){' | '}Csh:{' '}
              <span className="font-bold text-[var(--text-primary)]">
                {((plan.postTradeHoldings.cash / plan.accountValue) * 100).toFixed(2)}%
              </span>{' '}
              ({formatCurrency(plan.postTradeHoldings.cash)})
            </div>
          )}
        </div>
      </div>
      <div className="p-4 space-y-2">
        {plan.cashDepositContext && <CashDepositContextCard plan={plan} />}
        {plan.sleeveInstructions?.length ? <SleeveInstructionsTable plan={plan} /> : null}
        {plan.trades.length === 0 ? (
          <div className="text-sm text-[var(--green)] font-medium italic">
            Account is perfectly balanced. No trades required.
          </div>
        ) : (
          plan.trades.map((trade, tIdx) => (
            <div key={tIdx} className="flex justify-between items-center p-3.5 bg-[var(--bg-surface)] rounded-lg">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`text-[11px] font-bold px-2 py-0.5 rounded ${trade.type === 'Buy' ? 'bg-[var(--green-light)] text-[var(--green)]' : 'bg-[var(--red-light)] text-[var(--red)]'}`}
                  >
                    {trade.type}
                  </span>
                  <span className="text-[var(--text-primary)] font-semibold text-sm">{trade.asset}</span>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  <span className="text-[var(--text-label)] font-medium">Logic:</span> {trade.rationale}
                </p>
              </div>
              <div className="text-right shrink-0 ml-4">
                <div className="text-[var(--text-primary)] font-bold font-mono text-lg">
                  {plan.accountValue > 0 ? ((trade.amount / plan.accountValue) * 100).toFixed(2) : '0.00'}%
                </div>
                <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{formatCurrency(trade.amount)}</div>
              </div>
            </div>
          ))
        )}
      </div>
      {plan.varianceAnalysis && (
        <AccountVarianceTable variance={plan.varianceAnalysis} hasDepositContext={hasDepositContext} />
      )}
    </div>
  );
}

function formatSignedCurrency(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatCurrency(value)}`;
}

function CashDepositContextCard({ plan }: { plan: AccountExecutionPlan }) {
  const context = plan.cashDepositContext;
  if (!context) return null;

  return (
    <div className="p-3.5 bg-[var(--bg-surface)] rounded-lg border border-[var(--border)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-wider">
            Cash Deposit Context
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            New USD deposit is shown separately from existing cash/MMF. Specific buys are funded by the deposit where
            applicable.
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Deposit</div>
          <div className="font-mono text-sm font-bold text-[var(--green)]">{formatCurrency(context.depositAmount)}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-xs">
        <div>
          <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Existing Cash/MMF</div>
          <div className="font-mono font-bold text-[var(--text-primary)]">{formatCurrency(context.existingCash)}</div>
        </div>
        <div>
          <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Available Cash</div>
          <div className="font-mono font-bold text-[var(--text-primary)]">{formatCurrency(context.availableCash)}</div>
        </div>
        <div>
          <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Target Cash/MMF</div>
          <div className="font-mono font-bold text-[var(--text-primary)]">{formatCurrency(context.targetCash)}</div>
        </div>
        <div>
          <div className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Cash To Deploy</div>
          <div className="font-mono font-bold text-[var(--text-primary)]">{formatCurrency(context.cashToDeploy)}</div>
        </div>
      </div>
    </div>
  );
}

function SleeveInstructionsTable({ plan }: { plan: AccountExecutionPlan }) {
  const rows = plan.sleeveInstructions ?? [];
  if (!rows.length) return null;

  const sleeveLabel = (sleeve: string) => {
    if (sleeve === 'cash') return 'Cash/MMF';
    if (sleeve === 'fixed') return 'Fixed Income';
    return 'Equity';
  };

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="bg-[var(--bg-surface)] px-3 py-2 text-[10px] font-bold text-[var(--text-label)] uppercase tracking-wider">
        Sleeve Instructions
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)] uppercase">
            <th className="text-left px-3 py-2 font-bold">Sleeve</th>
            <th className="text-right px-3 py-2 font-bold">Current</th>
            <th className="text-right px-3 py-2 font-bold">Target</th>
            <th className="text-right px-3 py-2 font-bold">Delta</th>
            <th className="text-left px-3 py-2 font-bold">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-light)]">
          {rows.map((row) => (
            <tr key={row.sleeve}>
              <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{sleeveLabel(row.sleeve)}</td>
              <td className="px-3 py-2 text-right text-[var(--text-muted)] font-mono">{formatCurrency(row.current)}</td>
              <td className="px-3 py-2 text-right text-[var(--text-primary)] font-mono font-bold">
                {formatCurrency(row.target)}
              </td>
              <td className="px-3 py-2 text-right text-[var(--text-primary)] font-mono font-bold">
                {formatSignedCurrency(row.delta)}
              </td>
              <td className="px-3 py-2 text-[var(--text-muted)]">{row.source?.replace(/_/g, ' ') ?? 'N/A'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountVarianceTable({
  variance,
  hasDepositContext = false,
}: {
  variance: VarianceAnalysis;
  hasDepositContext?: boolean;
}) {
  const preTotal = variance.preTrade.cash + variance.preTrade.fixed + variance.preTrade.equity;
  const postTotal = variance.postTrade.cash + variance.postTrade.fixed + variance.postTrade.equity;
  const pct = (val: number, total: number) => (total > 0 ? `${((val / total) * 100).toFixed(2)}%` : '0.00%');

  const rows = [
    { label: 'Cash', pre: variance.preTrade.cash, post: variance.postTrade.cash },
    { label: 'Fixed Inc.', pre: variance.preTrade.fixed, post: variance.postTrade.fixed },
    { label: 'Equity', pre: variance.preTrade.equity, post: variance.postTrade.equity },
  ];

  return (
    <div className="px-4 pb-4">
      <div className="border border-[var(--border)] rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)] uppercase">
              <th className="text-left px-3 py-2 font-bold">Class</th>
              <th className="text-right px-3 py-2 font-bold">
                {hasDepositContext ? 'Before Deposit $' : 'Pre-Trade $'}
              </th>
              <th className="text-right px-3 py-2 font-bold">
                {hasDepositContext ? 'Before Deposit %' : 'Pre-Trade %'}
              </th>
              <th className="text-right px-3 py-2 font-bold">Post-Trade $</th>
              <th className="text-right px-3 py-2 font-bold">Post-Trade %</th>
              <th className="text-right px-3 py-2 font-bold">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-light)]">
            {rows.map((r) => {
              const delta = r.post - r.pre;
              const deltaColor =
                Math.abs(delta) < 1
                  ? 'text-[var(--text-muted)]'
                  : delta > 0
                    ? 'text-[var(--green)]'
                    : 'text-[var(--red)]';
              return (
                <tr key={r.label}>
                  <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{r.label}</td>
                  <td className="px-3 py-2 text-right text-[var(--text-muted)] font-mono">{formatCurrency(r.pre)}</td>
                  <td className="px-3 py-2 text-right text-[var(--text-muted)]">{pct(r.pre, preTotal)}</td>
                  <td className="px-3 py-2 text-right text-[var(--text-primary)] font-mono font-bold">
                    {formatCurrency(r.post)}
                  </td>
                  <td className="px-3 py-2 text-right text-[var(--text-primary)] font-bold">
                    {pct(r.post, postTotal)}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold font-mono ${deltaColor}`}>
                    {delta >= 0 ? '+' : ''}
                    {formatCurrency(delta)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HouseholdVarianceSummary({
  plans,
  baseAllocation,
}: {
  plans: AccountExecutionPlan[];
  baseAllocation: BaseAllocation;
}) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  const totals = plans.reduce(
    (acc, p) => {
      const va = p.varianceAnalysis;
      if (va) {
        acc.preCash += va.preTrade.cash;
        acc.preFixed += va.preTrade.fixed;
        acc.preEquity += va.preTrade.equity;
      }
      acc.postCash += p.postTradeHoldings?.cash ?? 0;
      acc.postFixed += p.postTradeHoldings?.fixed ?? 0;
      acc.postEquity += p.postTradeHoldings?.equity ?? 0;
      return acc;
    },
    { preCash: 0, preFixed: 0, preEquity: 0, postCash: 0, postFixed: 0, postEquity: 0 },
  );

  const preTotal = totals.preCash + totals.preFixed + totals.preEquity;
  const postTotal = totals.postCash + totals.postFixed + totals.postEquity;
  if (postTotal === 0) return null;

  const rows = [
    {
      label: 'Cash',
      pre: totals.preCash,
      post: totals.postCash,
      prePct: preTotal > 0 ? totals.preCash / preTotal : 0,
      targetPct: baseAllocation.cash / 100,
      actualPct: totals.postCash / postTotal,
    },
    {
      label: 'Fixed Inc.',
      pre: totals.preFixed,
      post: totals.postFixed,
      prePct: preTotal > 0 ? totals.preFixed / preTotal : 0,
      targetPct: baseAllocation.fixed / 100,
      actualPct: totals.postFixed / postTotal,
    },
    {
      label: 'Equity',
      pre: totals.preEquity,
      post: totals.postEquity,
      prePct: preTotal > 0 ? totals.preEquity / preTotal : 0,
      targetPct: baseAllocation.equity / 100,
      actualPct: totals.postEquity / postTotal,
    },
  ];

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-[10px] overflow-hidden">
      <div className="bg-[var(--bg-surface)] px-5 py-3 border-b border-[var(--border)]">
        <span className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-wider">
          Household Allocation Summary
        </span>
      </div>
      <div className="p-4">
        <div className="border border-[var(--border)] rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[var(--bg-surface)] text-[10px] text-[var(--text-muted)] uppercase">
                <th className="text-left px-3 py-2 font-bold">Class</th>
                <th className="text-right px-3 py-2 font-bold">Pre-Trade $</th>
                <th className="text-right px-3 py-2 font-bold">Pre-Trade %</th>
                <th className="text-right px-3 py-2 font-bold">Post-Trade $</th>
                <th className="text-right px-3 py-2 font-bold">Post-Trade %</th>
                <th className="text-right px-3 py-2 font-bold">Target %</th>
                <th className="text-right px-3 py-2 font-bold">Drift</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-light)]">
              {rows.map((r) => {
                const drift = r.prePct - r.targetPct;
                const driftColor =
                  Math.abs(drift) < 0.005
                    ? 'text-[var(--green)]'
                    : Math.abs(drift) < 0.02
                      ? 'text-[var(--yellow)]'
                      : 'text-[var(--red)]';
                return (
                  <tr key={r.label}>
                    <td className="px-3 py-2 font-medium text-[var(--text-primary)]">{r.label}</td>
                    <td className="px-3 py-2 text-right text-[var(--text-muted)] font-mono">{formatCurrency(r.pre)}</td>
                    <td className="px-3 py-2 text-right text-[var(--text-muted)]">{pct(r.prePct)}</td>
                    <td className="px-3 py-2 text-right text-[var(--text-primary)] font-mono font-bold">
                      {formatCurrency(r.post)}
                    </td>
                    <td className="px-3 py-2 text-right text-[var(--text-primary)] font-bold">{pct(r.actualPct)}</td>
                    <td className="px-3 py-2 text-right text-[var(--text-muted)]">{pct(r.targetPct)}</td>
                    <td className={`px-3 py-2 text-right font-bold ${driftColor}`}>
                      {drift >= 0 ? '+' : ''}
                      {pct(drift)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
