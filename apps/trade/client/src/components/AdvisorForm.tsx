import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import {
  Plus,
  Trash2,
  Send,
  RotateCcw,
  Copy,
  Database,
  Calendar,
  UserPlus,
  Loader2,
  ChevronDown,
  X,
  Users,
  Settings,
} from 'lucide-react';
import type {
  AssetLocationMode,
  Client,
  HouseholdResolveResponse,
  TradeRequest,
  TradeType,
  Residence,
  EsgFilters,
  EquityStrategy,
  Priority,
  LiquidateOption,
  LastAllocationData,
  AccountType,
  CreateTradeRequestPayload,
  ClientExclusion,
} from '@trade-request/shared';
import { isMaterialAllocationChange } from '@trade-request/shared';
import {
  allowedCashTicker,
  isKnownMmkTicker,
  type KnownMmkTicker,
  type TemplateMmkTicker,
} from '@trade-request/shared/allocations';
import { getRiskAllocation } from '../utils/allocation';
import { formatCurrency } from '../utils/format';
import { formatExclusionSide, formatExclusionsForTextarea, formatRestrictionReason } from '../utils/formatExclusions';
import {
  fetchLastAllocation,
  fetchClientExclusions,
  fetchBulkClientExclusions,
  fetchBulkAccountExclusions,
  fetchHouseholdResolution,
  type AccountExclusion,
} from '../api/client';
import { BenchmarkCombobox } from './BenchmarkCombobox';
import { HouseholdSidecar } from './HouseholdSidecar';
import { Tooltip } from './ui/Tooltip';
import { ManageExclusionsModal } from './ManageExclusionsModal';

/**
 * Build the textarea string for one kind. The single-client format matches
 * what advisors have typed by hand for years: `TICKER (reason); TICKER`.
 *
 * When 2+ clients are selected (household), each entry is suffixed with the
 * owning client's name so the advisor can tell whose exclusion is whose:
 *   `TICKER (reason – ClientName); TICKER (ClientName)`.
 *
 * Entries are emitted in the order clients appear in `clientsInOrder` to
 * keep the output stable across renders. Within one client, exclusions
 * preserve whatever order the API returned them in (server orders by
 * `kind, ticker`).
 *
 * Plan §4D (v3.2 amendment for households).
 */
// v3.4 — `formatExclusionsForTextarea` extracted to `utils/formatExclusions.ts`
// so it can be unit-tested in isolation without standing up the full form.
// The format change (DNB/DNS prefix) flows transparently through the existing
// auto-fill callers below.

const DEFAULT_ESG: EsgFilters = {
  fossilFuels: false,
  tobacco: false,
  weapons: false,
  alcohol: false,
  gambling: false,
  other: false,
  otherDescription: '',
  none: true,
};
const ESG_LABELS: Record<string, string> = {
  fossilFuels: 'Fossil Fuels',
  tobacco: 'Tobacco',
  weapons: 'Weapons',
  alcohol: 'Alcohol',
  gambling: 'Gambling',
  other: 'Other',
  none: 'None',
};

const ACCOUNT_TYPE_OPTIONS: AccountType[] = ['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA'];

interface ManualAccount {
  id: string;
  accountNumber: string;
  accountType: AccountType;
  balance: string;
}

const input =
  'w-full bg-[var(--bg-input)] border border-[var(--border)] rounded-lg p-2.5 text-[var(--text-primary)] text-[13px] outline-none transition-colors focus:border-[var(--text-muted)] focus:ring-1 focus:ring-[var(--border)]';
const label = 'text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2 block';

let listboxCounter = 0;

const ClientMultiSelect = memo(function ClientMultiSelect({
  clients,
  selectedIds,
  onChange,
  disabled,
  className,
}: {
  clients: Client[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [listboxId] = useState(() => `client-multiselect-listbox-${++listboxCounter}`);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = search
    ? clients.filter(
        (c) => c.name.toLowerCase().includes(search.toLowerCase()) || c.id.toLowerCase().includes(search.toLowerCase()),
      )
    : clients;

  const toggle = (id: string) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  const selectedClients = selectedIds.map((id) => clients.find((c) => c.id === id)).filter(Boolean) as Client[];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        className={`${className} text-left flex items-center justify-between gap-2 disabled:opacity-50`}
      >
        <span className="truncate flex-1">
          {selectedClients.length === 0 && <span className="text-[var(--text-muted)]">Select client(s)...</span>}
          {selectedClients.length === 1 && selectedClients[0].name}
          {selectedClients.length > 1 && (
            <span className="flex items-center gap-1.5">
              <Users size={13} className="text-[var(--text-label)] shrink-0" />
              {selectedClients.length} clients selected
            </span>
          )}
        </span>
        <ChevronDown
          size={14}
          className={`text-[var(--text-muted)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {selectedClients.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {selectedClients.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 bg-[var(--bg-surface)] border border-[var(--border)] text-[11px] font-medium text-[var(--text-primary)] px-2 py-1 rounded-md"
            >
              {c.name}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => toggle(c.id)}
                  aria-label={`Remove ${c.name}`}
                  className="text-[var(--text-muted)] hover:text-[var(--red)] transition-colors"
                >
                  <X size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {open && !disabled && (
        <div
          id={listboxId}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Client list"
          className="absolute z-30 mt-1 w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-lg max-h-64 overflow-hidden flex flex-col"
        >
          <div className="p-2 border-b border-[var(--border)]">
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={true}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeIndex >= 0 && filtered[activeIndex] ? `${listboxId}-opt-${filtered[activeIndex].id}` : undefined
              }
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setActiveIndex(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter' && activeIndex >= 0 && filtered[activeIndex]) {
                  e.preventDefault();
                  toggle(filtered[activeIndex].id);
                } else if (e.key === 'Escape') {
                  setOpen(false);
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  setActiveIndex(0);
                } else if (e.key === 'End') {
                  e.preventDefault();
                  setActiveIndex(filtered.length - 1);
                }
              }}
              placeholder="Search clients..."
              className="w-full bg-[var(--bg-surface)] border-none rounded-md px-2.5 py-1.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
          </div>
          <div ref={listRef} className="overflow-y-auto flex-1">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">No clients found</div>
            )}
            {filtered.map((c, i) => (
              <label
                key={c.id}
                id={`${listboxId}-opt-${c.id}`}
                role="option"
                aria-selected={selectedIds.includes(c.id)}
                className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors ${i === activeIndex ? 'bg-[var(--bg-surface)] outline outline-2 outline-[var(--bg-pill)] -outline-offset-2' : 'hover:bg-[var(--bg-surface)]'}`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(c.id)}
                  onChange={() => toggle(c.id)}
                  className="w-3.5 h-3.5 rounded accent-[var(--bg-pill)]"
                  tabIndex={-1}
                />
                <span className="text-[13px] text-[var(--text-primary)]">{c.name}</span>
                <span className="text-[11px] text-[var(--text-muted)] ml-auto">
                  {c.accounts.length} acct{c.accounts.length !== 1 ? 's' : ''}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

/**
 * Read the pending idempotency key for this form, minting and persisting one on
 * first use.
 *
 * The server dedups creates on `idempotency_key` (unique index
 * `idx_trade_requests_idempotency`), but only when a retry presents the SAME
 * key. Two things used to defeat that and turn a retry into a duplicate trade
 * request: the key was rotated even when the submit had failed, and any remount
 * (clone form, page reload) minted a fresh one. The route can commit a row and
 * still miss the 30s browser deadline — the advisor sees "please try again" for
 * a request that actually landed — so a retry MUST carry the original key.
 *
 * Hence sessionStorage rather than a per-mount ref, cleared only after a
 * confirmed success (see `rotateIdempotencyKey`).
 */
function readOrCreateIdempotencyKey(storageKey: string): string {
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(storageKey, fresh);
    return fresh;
  } catch {
    // Storage disabled (private mode, hardened browser). Degrade to a
    // per-mount key: same-mount retries still dedup, which is the common case.
    return crypto.randomUUID();
  }
}

interface Props {
  clientMap: Record<string, Client>;
  clients: Client[];
  isLoading: boolean;
  error?: string | null;
  submitError?: string | null;
  editRequest?: TradeRequest | null;
  cloneMode?: boolean;
  active?: boolean;
  onSubmit: (payload: CreateTradeRequestPayload) => void | Promise<void>;
  onCancel?: () => void;
}

export function AdvisorForm({
  clientMap,
  clients,
  isLoading,
  error = null,
  submitError = null,
  editRequest = null,
  cloneMode = false,
  active = true,
  onSubmit,
  onCancel,
}: Props) {
  const isEditing = !!editRequest && !cloneMode;
  const isCloning = !!editRequest && cloneMode;

  // Scoped per form identity so a new request, an edit, and a clone each keep
  // their own pending key — the clone/edit forms are `key`ed in App.tsx and
  // unmount on navigate, which is exactly when a per-mount ref would lose it.
  const idempotencyStorageKey = `trq:idempotency:${
    editRequest ? `${cloneMode ? 'clone' : 'edit'}-${editRequest.id}` : 'new'
  }`;
  const idempotencyKeyRef = useRef<string | null>(null);

  /** The key for the in-flight attempt, minted on first read. */
  const currentIdempotencyKey = (): string => {
    idempotencyKeyRef.current ??= readOrCreateIdempotencyKey(idempotencyStorageKey);
    return idempotencyKeyRef.current;
  };

  /** Called ONLY after a confirmed success — burns the key so the next genuine
   * request isn't deduped against the one just created. */
  const rotateIdempotencyKey = () => {
    try {
      sessionStorage.removeItem(idempotencyStorageKey);
    } catch {
      /* storage unavailable — the null below still forces a fresh key */
    }
    idempotencyKeyRef.current = null;
  };

  const [clientIds, setClientIds] = useState<string[]>(
    editRequest?.clientIds?.length ? editRequest.clientIds : editRequest?.clientId ? [editRequest.clientId] : [],
  );
  const [selectedAccts, setSelectedAccts] = useState<string[]>(editRequest?.selectedAccounts ?? []);
  const [tradeType, setTradeType] = useState<TradeType>(editRequest?.tradeType ?? 'Initial Funding');
  const [priority, setPriority] = useState<Priority | ''>(editRequest?.priority ?? '');

  // Manual entry mode
  const [manualClientMode, setManualClientMode] = useState(false);
  const [manualClientName, setManualClientName] = useState('');
  const [manualAccounts, setManualAccounts] = useState<ManualAccount[]>([]);
  const [manualSelectedAccts, setManualSelectedAccts] = useState<string[]>([]);

  // Full-form fields (Initial Funding / Rebalance / Cash Deposit)
  const [tradeAmount, setTradeAmount] = useState(editRequest?.tradeAmount ?? '');
  const [depositAccount, setDepositAccount] = useState(editRequest?.depositAccount ?? '');
  const [riskProfile, setRiskProfile] = useState<number | null>(editRequest?.riskProfile ?? null);
  const [equityStrats, setEquityStrats] = useState<EquityStrategy[]>(
    editRequest?.equityStrategies?.length
      ? editRequest.equityStrategies
      : [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
  );
  const [residence, setResidence] = useState<Residence>((editRequest?.residence as Residence) ?? 'Other');
  // Asset-location mode selector was removed from the UI; new requests default to
  // 'priority' and edits preserve the stored value. Engine/persistence are unchanged.
  const [assetLocationMode] = useState<AssetLocationMode>(editRequest?.assetLocationMode ?? 'priority');
  const [liquidationApproval, setLiquidationApproval] = useState(editRequest?.liquidationApproval ?? '');
  const [advisorExclusions, setAdvisorExclusions] = useState(editRequest?.advisorExclusions ?? '');
  const [clientExclusions, setClientExclusions] = useState(editRequest?.clientExclusions ?? '');
  const [esgFilters, setEsgFilters] = useState<EsgFilters>(editRequest?.esgFilters ?? { ...DEFAULT_ESG });

  // Raise Cash fields
  const [raiseCashReason, setRaiseCashReason] = useState(editRequest?.raiseCashReason ?? '');
  const [liquidityDeadline, setLiquidityDeadline] = useState(editRequest?.liquidityDeadline ?? '');

  // Liquidate fields
  const [liquidateOption, setLiquidateOption] = useState<LiquidateOption | ''>(editRequest?.liquidateOption ?? '');
  const [liquidatePositions, setLiquidatePositions] = useState(editRequest?.liquidatePositions ?? '');

  // Rebalance household toggle (Cash Deposit only — Initial Funding & Rebalance always true)
  const [rebalanceAll, setRebalanceHousehold] = useState(editRequest?.rebalanceAll ?? false);

  // Advisor notes (all types)
  const [advisorNotes, setAdvisorNotes] = useState(editRequest?.advisorNotes ?? '');

  // Submit state
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Last allocation memory
  const [lastAllocation, setLastAllocation] = useState<LastAllocationData | null>(null);
  const [lastAllocLoading, setLastAllocLoading] = useState(false);
  const [usePreviousAlloc, setUsePreviousAlloc] = useState<boolean | null>(null);
  const lastAllocRequestRef = useRef(0);

  // Firm-of-record household sidecar — see
  // `docs/plans/2026-q2-trade-request-householding.md`.
  // - `householdResolution` is the last successful response from the
  //   `/api/households/resolve` endpoint, or `null` if nothing has been
  //   resolved yet / the response was empty.
  // - `householdRequestRef` guards against out-of-order resolves: only
  //   the most recent in-flight fetch is allowed to clobber state.
  // - `dismissedHouseholdKey` memoizes "the advisor has dismissed this
  //   exact sidecar prompt", so swapping back to the same selection
  //   does NOT re-flash the sidecar. The key changes any time the
  //   underlying household set or sibling ULIDs change.
  const [householdResolution, setHouseholdResolution] = useState<HouseholdResolveResponse | null>(null);
  const [dismissedHouseholdKey, setDismissedHouseholdKey] = useState<string | null>(null);
  const householdRequestRef = useRef(0);

  // Standing exclusions auto-fill — see plan §4D.
  // - `lastRenderedExclusionsRef` records the formatted text we last wrote
  //   into each textarea from a standing-list fetch. Used by the
  //   "preserve-edits" overwrite policy to detect whether the user has typed
  //   on top of our auto-fill (in which case we leave their text alone).
  // - The "always-overwrite" policy (modal-save callback) ignores the ref
  //   when deciding whether to write, but still updates it afterwards so the
  //   next client-change comparison is consistent.
  const lastRenderedExclusionsRef = useRef<{ advisor: string; client: string }>({ advisor: '', client: '' });
  const exclusionsRequestRef = useRef(0);
  const [showExclusionsModal, setShowExclusionsModal] = useState(false);
  const [showAccountExclusionsModal, setShowAccountExclusionsModal] = useState(false);
  const accountExclusionsRequestRef = useRef(0);
  const [accountExclusionsByAccount, setAccountExclusionsByAccount] = useState<Record<string, AccountExclusion[]>>({});
  const [accountExclusionsLoading, setAccountExclusionsLoading] = useState(false);
  const [accountExclusionsError, setAccountExclusionsError] = useState<string | null>(null);
  const [accountExclusionsRefreshSeq, setAccountExclusionsRefreshSeq] = useState(0);

  const isFullForm = ['Initial Funding', 'Rebalance', 'Cash Deposit'].includes(tradeType);
  const isRaiseCash = tradeType === 'Raise Cash';
  const isLiquidate = tradeType === 'Liquidate';
  const showAllocPrompt = ['Rebalance', 'Cash Deposit'].includes(tradeType);
  const needsAmount = ['Cash Deposit', 'Raise Cash'].includes(tradeType);
  const primaryClientId = clientIds[0] ?? '';

  const baseAllocation = riskProfile === null ? null : getRiskAllocation(riskProfile);
  const totalEquitySplit = equityStrats.reduce((sum, s) => sum + (parseFloat(String(s.allocation)) || 0), 0);
  const isEquitySplitValid = totalEquitySplit === 100;
  const areStrategyBenchmarksValid = equityStrats.every((s) => s.benchmark.trim());
  const selectedClients = clientIds.map((id) => clientMap[id]).filter(Boolean);
  const selectedClient = selectedClients[0] ?? null;
  const allSelectedAccounts = selectedClients.flatMap((c) => c.accounts);
  const isManualClient = manualClientMode || primaryClientId.startsWith('manual-');
  const shouldRequireStrategyRationale =
    tradeType === 'Initial Funding' ||
    (showAllocPrompt &&
      (isManualClient ||
        lastAllocLoading ||
        !lastAllocation ||
        // When riskProfile is null the form isn't submittable anyway, so the
        // material-change comparison is moot — skip the gate.
        (riskProfile !== null &&
          baseAllocation !== null &&
          isMaterialAllocationChange(
            { riskProfile, baseAllocation, equityStrategies: equityStrats },
            lastAllocation,
          ))));

  // ─── MMK-in-equity-strategy validation ──────────────────────────────────
  // When an advisor parks a client in a money-market fund via the equity
  // strategy section (e.g. while the final allocation is still TBD), warn if
  // the chosen MMK ticker doesn't match the tax/account character of every
  // selected account. Reuses the same Strategy Rationale field for the
  // override audit trail. See server/src/data/allocationProfiles.ts for the
  // canonical (accountType, residence) → ticker mapping.
  const selectedAccountTypes = useMemo<AccountType[]>(() => {
    if (manualClientMode) {
      return manualAccounts.filter((a) => manualSelectedAccts.includes(a.id)).map((a) => a.accountType);
    }
    const acctSet = new Set(selectedAccts);
    return selectedClients.flatMap((c) =>
      c.accounts.filter((a) => acctSet.has(a.accountNumber)).map((a) => a.accountType),
    );
  }, [manualClientMode, manualAccounts, manualSelectedAccts, selectedClients, selectedAccts]);

  const mmkMismatchByStrategyId = useMemo(() => {
    const out = new Map<
      number,
      { entered: KnownMmkTicker; expected: TemplateMmkTicker[]; mismatchedTypes: AccountType[] }
    >();
    // Template tickers reachable under the current residence (across all 4 account
    // types). Always SWVXX (for IRAs) plus the residence's taxable/joint template.
    // Any MMK that isn't one of these is a policy deviation — warn even before
    // accounts are picked so the advisor sees the issue immediately.
    const ALL_ACCOUNT_TYPES: AccountType[] = ['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA'];
    const possibleAllowed = new Set<TemplateMmkTicker>(ALL_ACCOUNT_TYPES.map((t) => allowedCashTicker(t, residence)));
    for (const strat of equityStrats) {
      const symbol = strat.benchmark.trim().toUpperCase();
      if (!isKnownMmkTicker(symbol)) continue;

      if (selectedAccountTypes.length === 0) {
        // Pre-account-selection: warn whenever the ticker isn't one of the
        // template tickers reachable under this residence (catches both
        // wrong-state templates like VYFXX/CA and non-template MMKs like SPAXX).
        if (!possibleAllowed.has(symbol as TemplateMmkTicker)) {
          out.set(strat.id, {
            entered: symbol,
            expected: Array.from(possibleAllowed),
            mismatchedTypes: [],
          });
        }
        continue;
      }

      const expectedSet = new Set<TemplateMmkTicker>();
      const mismatchedTypes: AccountType[] = [];
      for (const accType of selectedAccountTypes) {
        const allowed = allowedCashTicker(accType, residence);
        expectedSet.add(allowed);
        if (allowed !== symbol && !mismatchedTypes.includes(accType)) mismatchedTypes.push(accType);
      }
      if (mismatchedTypes.length > 0) {
        out.set(strat.id, { entered: symbol, expected: Array.from(expectedSet), mismatchedTypes });
      }
    }
    return out;
  }, [equityStrats, selectedAccountTypes, residence]);

  const isStrategyRationaleRequired = useCallback(
    (stratId: number) => shouldRequireStrategyRationale || mmkMismatchByStrategyId.has(stratId),
    [shouldRequireStrategyRationale, mmkMismatchByStrategyId],
  );

  const areStrategyRationalesValid = equityStrats.every(
    (s) => !isStrategyRationaleRequired(s.id) || s.rationale?.trim(),
  );
  const areStrategiesValid = areStrategyBenchmarksValid && areStrategyRationalesValid;
  const hasClientSelection = manualClientMode ? manualClientName.trim().length > 0 : clientIds.length > 0;
  const selectedManualAccountsValid =
    manualSelectedAccts.length > 0 &&
    manualAccounts
      .filter((a) => manualSelectedAccts.includes(a.id))
      .every((a) => a.accountNumber.trim() && parseFloat(a.balance.replace(/[^0-9.]/g, '')) > 0);
  const hasAccountSelection = manualClientMode ? selectedManualAccountsValid : selectedAccts.length > 0;

  // Server-side caps from createRequestSchema (server/src/routes/requests.ts) —
  // mirror them here so the user gets a clear message instead of a generic
  // "Validation failed" toast when an HNW household has many sub-accounts.
  const MAX_SELECTED_ACCOUNTS = 50;
  const MAX_SELECTED_CLIENTS = 50;
  const MAX_RATIONALE_CHARS = 5000;
  const effectiveSelectedCount = manualClientMode ? manualSelectedAccts.length : selectedAccts.length;
  const tooManyAccounts = effectiveSelectedCount > MAX_SELECTED_ACCOUNTS;
  const tooManyClients = !manualClientMode && clientIds.length > MAX_SELECTED_CLIENTS;
  const capWarning = tooManyAccounts
    ? `You have selected ${effectiveSelectedCount} accounts. Please reduce to ${MAX_SELECTED_ACCOUNTS} or fewer to submit.`
    : tooManyClients
      ? `You have selected ${clientIds.length} clients. Please reduce to ${MAX_SELECTED_CLIENTS} or fewer to submit.`
      : null;

  // Per-type validation
  let isFormInvalid = !hasClientSelection || !hasAccountSelection || !priority || tooManyAccounts || tooManyClients;
  if (isFullForm) {
    const isComplianceValid = !!residence && !!liquidationApproval;
    isFormInvalid = isFormInvalid || !isComplianceValid || !isEquitySplitValid || !areStrategiesValid;
    // Risk score must be deliberately picked for every full-form trade type —
    // mirrors the server-side superRefine in routes/requests.ts.
    isFormInvalid = isFormInvalid || riskProfile === null;
    if (tradeType === 'Cash Deposit') isFormInvalid = isFormInvalid || !tradeAmount || !depositAccount;
  } else if (isRaiseCash) {
    isFormInvalid = isFormInvalid || !tradeAmount || !raiseCashReason.trim();
  } else if (isLiquidate) {
    isFormInvalid = isFormInvalid || !liquidateOption;
    if (liquidateOption === 'Specific Positions') isFormInvalid = isFormInvalid || !liquidatePositions.trim();
  }

  // Fetch last allocation when client + applicable trade type
  const loadLastAlloc = useCallback(async (cId: string) => {
    const requestId = ++lastAllocRequestRef.current;
    setLastAllocLoading(true);
    try {
      const data = await fetchLastAllocation(cId);
      if (lastAllocRequestRef.current === requestId) {
        setLastAllocation(data);
        if (!data) setUsePreviousAlloc(false);
      }
    } catch {
      if (lastAllocRequestRef.current === requestId) {
        setLastAllocation(null);
        setUsePreviousAlloc(false);
      }
    } finally {
      if (lastAllocRequestRef.current === requestId) {
        setLastAllocLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    if (primaryClientId && showAllocPrompt && !isManualClient) {
      loadLastAlloc(primaryClientId);
      setUsePreviousAlloc(null);
    } else {
      setLastAllocation(null);
      setUsePreviousAlloc(showAllocPrompt && isManualClient ? false : null);
    }
  }, [active, primaryClientId, tradeType, showAllocPrompt, loadLastAlloc, isManualClient]);

  /**
   * Apply a standing-exclusion list to the two textareas.
   *
   * - `'preserve-edits'` (default — used on client change): write only if the
   *   textarea is empty OR matches the previously-rendered standing list text.
   *   Protects user-typed overrides within a session.
   * - `'always-overwrite'` (used after the modal saves): always write. The
   *   user just made an explicit change via the modal; any textarea content
   *   was layered on top of the *old* list and is now stale.
   *
   * In both cases the ref is updated so subsequent decisions stay consistent.
   * See plan §4D.
   */
  /**
   * Apply pre-formatted standing-exclusion text to the two textareas. The
   * formatting (single vs aggregated-with-attribution) is done by the caller
   * because aggregation needs each client's name, which lives in the parent
   * `selectedClients` array, not in the per-entry payload.
   */
  const applyStandingExclusions = useCallback(
    (advisorText: string, clientText: string, mode: 'preserve-edits' | 'always-overwrite') => {
      const prev = lastRenderedExclusionsRef.current;

      setAdvisorExclusions((current) => {
        if (mode === 'always-overwrite') return advisorText;
        if (current === '' || current === prev.advisor) return advisorText;
        return current;
      });
      setClientExclusions((current) => {
        if (mode === 'always-overwrite') return clientText;
        if (current === '' || current === prev.client) return clientText;
        return current;
      });

      lastRenderedExclusionsRef.current = { advisor: advisorText, client: clientText };
    },
    [],
  );

  // selectedClients changes identity on every render, so derive a stable
  // dependency from the IDs only. (Effect re-runs only when the actual list
  // of selected client IDs changes, not on every re-render.)
  const selectedClientIdsKey = selectedClients.map((c) => c.id).join(',');

  // Auto-fill from the standing list when the selected client(s) change.
  // Edit and clone modes are bypassed entirely — those flows must show the
  // request's snapshotted exclusions, not the (possibly newer) standing list.
  // For households (2+ clients) we pull all standing lists via the bulk
  // endpoint and aggregate with attribution. See plan §4D (v3.2 amendment).
  useEffect(() => {
    if (!active) return;
    if (editRequest) return; // covers both edit (isEditing) and clone (isCloning)
    if (selectedClients.length === 0 || isManualClient) {
      // Do NOT wipe `lastRenderedExclusionsRef` here. The ref tracks the last
      // text WE auto-wrote, and that fact doesn't change just because the
      // user momentarily deselected everyone on the way to picking someone
      // else. Wiping it broke client-switch through an empty state: the
      // preserve-edits check below would then compare the still-present
      // previous client's text against an empty ref, fail, and refuse to
      // overwrite — leaving the textarea stuck on the prior client's rules
      // while the modal (which reads fresh) showed the new client's rules.
      return;
    }

    const clientsSnapshot = selectedClients.map((c) => ({ id: c.id, name: c.name }));
    const requestId = ++exclusionsRequestRef.current;
    const controller = new AbortController();

    // Single client: single fetch (saves a server roundtrip vs bulk-of-1).
    // Multi: bulk fetch keyed by clientId.
    const fetcher: Promise<Record<string, ClientExclusion[]>> =
      clientsSnapshot.length === 1
        ? fetchClientExclusions(clientsSnapshot[0].id, controller.signal).then((entries) => ({
            [clientsSnapshot[0].id]: entries,
          }))
        : fetchBulkClientExclusions(clientsSnapshot.map((c) => c.id));

    fetcher
      .then((byClient) => {
        if (exclusionsRequestRef.current !== requestId) return;
        const advisor = formatExclusionsForTextarea(byClient, clientsSnapshot, 'advisor');
        const client = formatExclusionsForTextarea(byClient, clientsSnapshot, 'client');
        applyStandingExclusions(advisor, client, 'preserve-edits');
      })
      .catch(() => {
        // Best-effort: silently keep whatever was in the textareas. This
        // matches the rollback behavior the plan calls for if the route
        // ever 404s. fetchBulkClientExclusions only catches via the parent
        // chain — explicit catch here for the single-client branch too.
      });

    return () => controller.abort();
    // Note: `selectedClients` is intentionally NOT in the dep array. Its
    // array identity changes every parent render, which would re-run this
    // effect spuriously. `selectedClientIdsKey` is the stable representation
    // — same IDs = same key string — and we snapshot `selectedClients` at
    // the top of the effect body to capture the names safely.
  }, [active, selectedClientIdsKey, isManualClient, editRequest, applyStandingExclusions]);

  // Modal-save callback. Always overwrites, regardless of edit state, since
  // the parent guarantees we won't even render the modal in edit/clone mode
  // (the button is gated on `!editRequest`). Re-runs the same aggregation
  // path as the client-change effect.
  const handleExclusionsSaved = useCallback(() => {
    if (selectedClients.length === 0) return;
    const clientsSnapshot = selectedClients.map((c) => ({ id: c.id, name: c.name }));
    const fetcher: Promise<Record<string, ClientExclusion[]>> =
      clientsSnapshot.length === 1
        ? fetchClientExclusions(clientsSnapshot[0].id).then((entries) => ({
            [clientsSnapshot[0].id]: entries,
          }))
        : fetchBulkClientExclusions(clientsSnapshot.map((c) => c.id));

    fetcher
      .then((byClient) => {
        const advisor = formatExclusionsForTextarea(byClient, clientsSnapshot, 'advisor');
        const client = formatExclusionsForTextarea(byClient, clientsSnapshot, 'client');
        applyStandingExclusions(advisor, client, 'always-overwrite');
      })
      .catch(() => {});
  }, [selectedClients, applyStandingExclusions]);

  const canManageExclusions = !editRequest && selectedClients.length > 0 && !isManualClient;

  // ─── Household sidecar wiring ──────────────────────────────────────────────
  // See `docs/plans/2026-q2-trade-request-householding.md` §6 Step 6.
  //
  // The new endpoint accepts Apex ULIDs (Account.id) only — `selectedAccts`
  // here holds custodian numbers (Account.accountNumber), so we translate
  // through `clientMap[…].accounts` before calling. Misses (e.g. manual
  // accounts) are filtered out.
  const selectedAccountUlids = useCallback((): string[] => {
    const ulids: string[] = [];
    for (const num of selectedAccts) {
      for (const cid of clientIds) {
        const acct = clientMap[cid]?.accounts.find((a) => a.accountNumber === num);
        if (acct) {
          ulids.push(acct.id);
          break;
        }
      }
    }
    return ulids;
  }, [selectedAccts, clientIds, clientMap]);

  // Stable representations for the resolve effect's dep array (same trick as
  // `selectedClientIdsKey` above — array identity changes every render).
  const clientIdsKey = clientIds.join(',');
  const selectedAcctsKey = selectedAccts.join(',');

  // Fetch account-scoped standing exclusions for the currently selected
  // account ULIDs so advisors can see per-account restrictions that are not
  // visible in the client-level modal.
  useEffect(() => {
    if (!active) return;
    if (manualClientMode || selectedAccts.length === 0) {
      setAccountExclusionsByAccount({});
      setAccountExclusionsError(null);
      setAccountExclusionsLoading(false);
      return;
    }

    const accountIds = selectedAccountUlids();
    if (accountIds.length === 0) {
      setAccountExclusionsByAccount({});
      setAccountExclusionsError(null);
      setAccountExclusionsLoading(false);
      return;
    }

    const requestId = ++accountExclusionsRequestRef.current;
    setAccountExclusionsLoading(true);
    setAccountExclusionsError(null);

    fetchBulkAccountExclusions(accountIds)
      .then((byAccount) => {
        if (accountExclusionsRequestRef.current !== requestId) return;
        setAccountExclusionsByAccount(byAccount);
      })
      .catch(() => {
        if (accountExclusionsRequestRef.current !== requestId) return;
        setAccountExclusionsByAccount({});
        setAccountExclusionsError('Unable to load account-level exclusions.');
      })
      .finally(() => {
        if (accountExclusionsRequestRef.current !== requestId) return;
        setAccountExclusionsLoading(false);
      });
  }, [
    active,
    manualClientMode,
    selectedAccts.length,
    selectedAcctsKey,
    clientIdsKey,
    selectedAccountUlids,
    accountExclusionsRefreshSeq,
  ]);

  const selectedAcctsSet = useMemo(() => new Set(selectedAccts), [selectedAccts]);

  const accountExclusionGroups = useMemo(() => {
    return selectedClients.flatMap((client) =>
      client.accounts
        .filter((account) => selectedAcctsSet.has(account.accountNumber))
        .map((account) => ({
          accountId: account.id,
          accountNumber: account.accountNumber,
          clientName: client.name,
          exclusions: accountExclusionsByAccount[account.id] ?? [],
        })),
    );
  }, [selectedClients, selectedAcctsSet, accountExclusionsByAccount]);

  const accountExclusionCount = useMemo(
    () => accountExclusionGroups.reduce((total, group) => total + group.exclusions.length, 0),
    [accountExclusionGroups],
  );

  const selectedAccountTargets = useMemo(
    () =>
      accountExclusionGroups.map((group) => ({
        id: group.accountId,
        accountNumber: group.accountNumber,
        clientName: group.clientName,
      })),
    [accountExclusionGroups],
  );

  const canManageAccountExclusions = !editRequest && selectedAccountTargets.length > 0 && !isManualClient;

  const handleAccountExclusionsSaved = useCallback(() => {
    setAccountExclusionsRefreshSeq((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (manualClientMode) {
      setHouseholdResolution(null);
      return;
    }
    if (isEditing) {
      // Edit mode: persistence is immutable (Decision log #5) and we don't
      // want the sidecar prompting changes on a request that has already
      // been submitted. Read-only edit flows therefore skip the resolve
      // call entirely.
      return;
    }
    if (clientIds.length === 0 && selectedAccts.length === 0) {
      setHouseholdResolution(null);
      return;
    }

    const requestId = ++householdRequestRef.current;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      const accountIds = selectedAccountUlids();
      fetchHouseholdResolution({ clientIds, accountIds, signal: controller.signal })
        .then((res) => {
          if (householdRequestRef.current !== requestId) return; // stale
          setHouseholdResolution(res);
        })
        .catch(() => {
          // Silent-fallback contract is already applied in the API shim
          // (503 → empty resolution). Anything that lands here is a
          // genuine error; keep the previous state and don't surface it
          // to the advisor.
        });
    }, 150);

    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [
    active,
    manualClientMode,
    isEditing,
    clientIdsKey,
    selectedAcctsKey,
    selectedAccountUlids,
    clientIds,
    selectedAccts,
  ]);

  // Stable dismiss memo (Decision log #1). The key includes every household
  // ID and every sibling ULID; any underlying change makes a "new" sidecar
  // that should reappear even if the advisor dismissed the prior one.
  const householdResolutionKey = useMemo(() => {
    if (!householdResolution) return null;
    const parts: string[] = [];
    for (const h of [...householdResolution.households].sort((a, b) => a.householdId - b.householdId)) {
      parts.push(`H${h.householdId}:${[...h.accounts.map((a) => a.accountId)].sort().join('|')}`);
    }
    return parts.join(';;');
  }, [householdResolution]);

  // Translate sibling ULIDs back to account numbers via the resolution's
  // own `HouseholdResolutionAccount.accountNumber` field (which carries
  // the Warehouse join). Siblings without a Warehouse row (`accountNumber === null`)
  // cannot be checked in the form's account picker, so we silently drop them.
  const mergeSiblingsIntoSelection = useCallback(
    (siblingClientIds: string[], siblingAccountUlids: string[]) => {
      if (!householdResolution) return;
      const ulidToNumber = new Map<string, string>();
      for (const h of householdResolution.households) {
        for (const a of h.accounts) {
          if (a.accountNumber) ulidToNumber.set(a.accountId, a.accountNumber);
        }
      }
      const newAcctNumbers = siblingAccountUlids
        .map((u) => ulidToNumber.get(u))
        .filter((n): n is string => !!n && !selectedAccts.includes(n));
      const newClientIds = siblingClientIds.filter((c) => !clientIds.includes(c));
      if (newClientIds.length > 0) setClientIds([...clientIds, ...newClientIds]);
      if (newAcctNumbers.length > 0) setSelectedAccts([...selectedAccts, ...newAcctNumbers]);
    },
    [householdResolution, selectedAccts, clientIds],
  );

  const dismissSidecar = useCallback(() => {
    setDismissedHouseholdKey(householdResolutionKey);
  }, [householdResolutionKey]);

  const showHouseholdSidecar =
    !!householdResolution &&
    !manualClientMode &&
    !isEditing &&
    householdResolutionKey !== null &&
    dismissedHouseholdKey !== householdResolutionKey;

  // Submit-time household tag (Decision log #5). Computed from the FINAL
  // ULID set, NOT from sidecar state. Single firm household → persist;
  // anything else (multi-household, unmapped, manual, edit) → (null, null).
  const computeHouseholdTagForSubmit = useCallback((): { householdId: number | null; householdName: string | null } => {
    if (manualClientMode || isEditing) return { householdId: null, householdName: null };
    if (!householdResolution) return { householdId: null, householdName: null };
    const ulids = selectedAccountUlids();
    if (ulids.length === 0) return { householdId: null, householdName: null };
    const ulidToTag = new Map<string, { id: number; name: string }>();
    for (const h of householdResolution.households) {
      for (const a of h.accounts) ulidToTag.set(a.accountId, { id: h.householdId, name: h.householdName });
    }
    const tags = ulids.map((u) => ulidToTag.get(u));
    const allMapped = tags.every((t) => t !== undefined);
    if (!allMapped) return { householdId: null, householdName: null };
    const firstId = tags[0]!.id;
    const allSame = tags.every((t) => t!.id === firstId);
    if (!allSame) return { householdId: null, householdName: null };
    return { householdId: firstId, householdName: tags[0]!.name };
  }, [manualClientMode, isEditing, householdResolution, selectedAccountUlids]);

  const applyPreviousAllocation = () => {
    if (!lastAllocation) return;
    setUsePreviousAlloc(true);
    setRiskProfile(lastAllocation.riskProfile);
    setEquityStrats(
      lastAllocation.equityStrategies.length > 0
        ? lastAllocation.equityStrategies
        : [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }],
    );
  };

  const declinePreviousAllocation = () => {
    setUsePreviousAlloc(false);
    setRiskProfile(null);
    setEquityStrats([{ id: 1, benchmark: 'SPY', allocation: 100, rationale: '' }]);
  };

  const handleClientChange = useCallback((ids: string[]) => {
    setClientIds(ids);
    setSelectedAccts([]);
    setDepositAccount('');
  }, []);
  const toggleAccount = useCallback((acctNum: string) => {
    setSelectedAccts((prev) => (prev.includes(acctNum) ? prev.filter((a) => a !== acctNum) : [...prev, acctNum]));
  }, []);
  const toggleManualAccount = useCallback((id: string) => {
    setManualSelectedAccts((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }, []);
  const toggleEsg = useCallback((key: string) => {
    if (key === 'none') {
      setEsgFilters({ ...DEFAULT_ESG });
      return;
    }
    if (key === 'other') {
      setEsgFilters((prev) => ({
        ...prev,
        other: !prev.other,
        otherDescription: !prev.other ? prev.otherDescription : '',
        none: false,
      }));
      return;
    }
    setEsgFilters((prev) => ({ ...prev, [key]: !prev[key as keyof EsgFilters], none: false }));
  }, []);
  const addEquityStrat = useCallback(() => {
    setEquityStrats((prev) =>
      prev.length >= 3 ? prev : [...prev, { id: Date.now(), benchmark: '', allocation: 0, rationale: '' }],
    );
  }, []);
  const removeEquityStrat = useCallback((id: number) => {
    setEquityStrats((prev) => prev.filter((s) => s.id !== id));
  }, []);
  const updateEquityStrat = useCallback((id: number, field: keyof EquityStrategy, value: string | number) => {
    setEquityStrats((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }, []);

  const addManualAccount = () => {
    setManualAccounts((prev) => [
      ...prev,
      { id: String(Date.now()), accountNumber: '', accountType: 'Taxable', balance: '' },
    ]);
  };
  const removeManualAccount = (id: string) => {
    setManualAccounts((prev) => prev.filter((a) => a.id !== id));
    setManualSelectedAccts((prev) => prev.filter((a) => a !== id));
  };
  const updateManualAccount = (id: string, field: keyof ManualAccount, value: string) => {
    setManualAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, [field]: value } : a)));
  };
  const toggleManualClientMode = () => {
    setManualClientMode((prev) => {
      if (!prev) {
        setClientIds([]);
        setSelectedAccts([]);
      } else {
        setManualClientName('');
        setManualAccounts([]);
        setManualSelectedAccts([]);
      }
      return !prev;
    });
  };

  const effectiveClientName = manualClientMode
    ? manualClientName
    : selectedClients.length > 1
      ? selectedClients.map((c) => c.name).join(' & ')
      : (selectedClient?.name ?? '');
  const effectiveSelectedAccts = manualClientMode
    ? manualAccounts.filter((a) => manualSelectedAccts.includes(a.id)).map((a) => a.accountNumber || a.id)
    : selectedAccts;

  const handleTradeTypeChange = (newType: TradeType) => {
    setTradeType(newType);
    setTradeAmount('');
    setDepositAccount('');
    setRebalanceHousehold(newType === 'Rebalance' || newType === 'Initial Funding');
    setRaiseCashReason('');
    setLiquidityDeadline('');
    setLiquidateOption('');
    setLiquidatePositions('');
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    const manualAccountDetails = manualClientMode
      ? manualAccounts
          .filter((a) => manualSelectedAccts.includes(a.id))
          .map((a) => ({
            accountNumber: a.accountNumber,
            accountType: a.accountType,
            balance: parseFloat(a.balance.replace(/[^0-9.]/g, '')) || 0,
          }))
      : undefined;

    const accountsData =
      !manualClientMode && selectedClients.length > 0
        ? allSelectedAccounts
            .filter((a) => selectedAccts.includes(a.accountNumber))
            .map((a) => ({ accountNumber: a.accountNumber, accountType: a.accountType, balance: a.balance }))
        : undefined;

    // Build aligned (clientIds, clientNames) — always send both arrays with the
    // same length, falling back to the id when a client is missing from clientMap
    // (e.g. clients list was refetched mid-session). Sending clientIds without a
    // matching clientNames trips a server validation error.
    const sendMultiClient = !manualClientMode && clientIds.length > 1;
    const multiClientNames = sendMultiClient ? clientIds.map((id) => clientMap[id]?.name ?? id) : undefined;

    const householdTag = computeHouseholdTagForSubmit();

    try {
      await onSubmit({
        clientId: manualClientMode ? `manual-${Date.now()}` : primaryClientId,
        clientName: effectiveClientName,
        clientIds: sendMultiClient ? clientIds : undefined,
        clientNames: sendMultiClient ? multiClientNames : undefined,
        tradeType,
        tradeAmount: needsAmount || tradeType === 'Raise Cash' ? tradeAmount : '',
        depositAccount: tradeType === 'Cash Deposit' ? depositAccount : '',
        rebalanceAll: ['Initial Funding', 'Rebalance'].includes(tradeType) ? true : rebalanceAll,
        selectedAccounts: effectiveSelectedAccts,
        accountsData,
        priority: priority as Priority,
        advisorNotes,
        residence: isFullForm ? residence : 'Other',
        liquidationApproval: isFullForm ? liquidationApproval : '',
        advisorExclusions: isFullForm ? advisorExclusions : '',
        clientExclusions: isFullForm ? clientExclusions : '',
        esgFilters: isFullForm ? esgFilters : { ...DEFAULT_ESG },
        riskProfile: isFullForm ? riskProfile : null,
        equityStrategies: isFullForm ? equityStrats : [],
        raiseCashReason: isRaiseCash ? raiseCashReason : '',
        liquidityDeadline: isRaiseCash && liquidityDeadline ? liquidityDeadline : null,
        liquidateOption: isLiquidate ? liquidateOption : '',
        liquidatePositions: isLiquidate ? liquidatePositions : '',
        existingId: isEditing ? editRequest?.id : null,
        isClone: isCloning,
        manualEntry: manualClientMode || undefined,
        manualAccounts: manualAccountDetails,
        idempotencyKey: currentIdempotencyKey(),
        assetLocationMode: isFullForm ? assetLocationMode : 'priority',
        householdId: householdTag.householdId,
        householdName: householdTag.householdName,
      });
      rotateIdempotencyKey();
    } catch {
      // Deliberately swallowed: the parent surfaces the message via the
      // `submitError` prop. What matters here is that we DON'T rotate the key —
      // the submit may have committed server-side despite the error the browser
      // saw, so the advisor's retry has to present the same key to dedup.
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div
        className="p-10 text-center text-[var(--text-muted)] animate-pulse"
        role="status"
        aria-live="polite"
        aria-busy={true}
      >
        Connecting to Warehouse API...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-10 text-center">
        <div className="text-[var(--red)] text-[14px] font-medium mb-2">Failed to load client data</div>
        <div className="text-[var(--text-muted)] text-[13px]">{error}</div>
      </div>
    );
  }

  // Section numbering adapts to trade type
  let sectionNum = 1;

  return (
    <div className="max-w-4xl mx-auto pb-12">
      <div className="bg-[var(--bg-card)] rounded-[14px] border border-[var(--border)] overflow-hidden">
        <div className="px-7 py-5 border-b border-[var(--border)] flex justify-between items-center">
          <h2 className="font-serif text-xl font-medium text-[var(--text-primary)] flex items-center gap-2">
            {isEditing && <RotateCcw size={18} className="text-[var(--yellow)]" />}
            {isCloning && <Copy size={18} className="text-[var(--text-label)]" />}
            {isEditing
              ? `Resubmit: ${editRequest!.id}`
              : isCloning
                ? `Clone from ${editRequest!.id}`
                : 'New Trade Request'}
          </h2>
          {clients.length > 0 && (
            <Tooltip content="Client data loaded live from Warehouse" position="bottom">
              <div className="flex items-center gap-2 text-xs text-[var(--green)] bg-[var(--green-light)] px-3 py-1.5 rounded-full font-medium">
                <Database size={12} /> Connected to Warehouse
              </div>
            </Tooltip>
          )}
        </div>

        {submitError && (
          <div
            id="advisor-form-submit-error"
            role="alert"
            className="mx-7 mt-4 bg-[var(--red-light)] border border-[var(--red-border)] rounded-xl px-4 py-3 text-[13px] text-[var(--red)]"
          >
            {submitError}
          </div>
        )}

        {capWarning && (
          <div
            id="advisor-form-cap-warning"
            role="alert"
            className="mx-7 mt-4 bg-[var(--yellow-light,_#fff7e6)] border border-[var(--yellow-border,_#f5c97a)] rounded-xl px-4 py-3 text-[13px] text-[var(--yellow,_#92400e)]"
          >
            {capWarning}
          </div>
        )}

        <div className="p-7 space-y-8">
          {/* ── Section: Client & Account Context ── */}
          <div className="space-y-4">
            <div className="flex justify-between items-end border-b border-[var(--border)] pb-2">
              <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest">
                {sectionNum++}. Client & Account Context
              </h3>
              {!isEditing && (
                <Tooltip
                  content={
                    manualClientMode ? 'Switch back to Warehouse client list' : 'Enter client details not in Warehouse'
                  }
                  position="bottom"
                >
                  <button
                    type="button"
                    onClick={toggleManualClientMode}
                    className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-label)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    <UserPlus size={13} />
                    {manualClientMode ? 'Use Warehouse list' : 'Enter manually'}
                  </button>
                </Tooltip>
              )}
            </div>
            <div className="grid grid-cols-3 gap-6">
              <div>
                {manualClientMode ? (
                  <>
                    <label htmlFor="advisor-form-manual-client" className={label}>
                      Client Name (Manual)
                    </label>
                    <input
                      id="advisor-form-manual-client"
                      type="text"
                      value={manualClientName}
                      onChange={(e) => setManualClientName(e.target.value)}
                      placeholder="e.g., John Smith"
                      className={input}
                    />
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className={label}>
                        Client / Household{' '}
                        {clientIds.length > 1 ? (
                          <span className="text-[var(--text-label)]">({clientIds.length})</span>
                        ) : (
                          ''
                        )}
                      </label>
                      <Tooltip
                        content={
                          canManageExclusions
                            ? clientIds.length > 1
                              ? 'Add or remove standing exclusions for any client in this household — switch tabs inside the modal'
                              : 'Add or remove standing exclusions for this client without submitting a trade request'
                            : editRequest
                              ? 'Standing list is disabled in edit / clone mode'
                              : 'Select a client first'
                        }
                        position="bottom"
                      >
                        <button
                          type="button"
                          onClick={() => setShowExclusionsModal(true)}
                          disabled={!canManageExclusions}
                          className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-label)] hover:text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <Settings size={13} />
                          Manage exclusions
                        </button>
                      </Tooltip>
                    </div>
                    <ClientMultiSelect
                      clients={clients}
                      selectedIds={clientIds}
                      onChange={handleClientChange}
                      disabled={isEditing}
                      className={`${input} disabled:opacity-50`}
                    />
                  </>
                )}
              </div>
              <div>
                <label htmlFor="advisor-form-trade-type" className={label}>
                  Trade Type
                </label>
                <select
                  id="advisor-form-trade-type"
                  value={tradeType}
                  onChange={(e) => handleTradeTypeChange(e.target.value as TradeType)}
                  className={input}
                >
                  <option>Initial Funding</option>
                  <option>Rebalance</option>
                  <option>Cash Deposit</option>
                  <option>Raise Cash</option>
                  <option>Liquidate</option>
                </select>
              </div>
              <div>
                <label htmlFor="advisor-form-priority" className={label}>
                  Priority <span className="text-[var(--red)]">*</span>
                </label>
                <select
                  id="advisor-form-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                  aria-required="true"
                  className={input}
                >
                  <option value="" disabled>
                    Select a priority
                  </option>
                  <option value="Urgent">Urgent</option>
                  <option value="Standard">Standard</option>
                  <option value="Low">Low</option>
                </select>
              </div>
            </div>

            {/* Manual account entry */}
            {manualClientMode && manualClientName.trim() && (
              <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-[10px] p-5 mt-4">
                <div className="flex justify-between items-center mb-3">
                  <p className={`${label} mb-0`}>Accounts (Manual Entry)</p>
                  {manualSelectedAccts.length > 0 && (
                    <span className="text-xs font-mono font-bold text-[var(--text-primary)]">
                      Total:{' '}
                      {formatCurrency(
                        manualAccounts
                          .filter((a) => manualSelectedAccts.includes(a.id))
                          .reduce((s, a) => s + (parseFloat(a.balance.replace(/[^0-9.]/g, '')) || 0), 0),
                      )}
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {manualAccounts.map((acc) => (
                    <div
                      key={acc.id}
                      className="p-3.5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] space-y-2"
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={manualSelectedAccts.includes(acc.id)}
                          onChange={() => toggleManualAccount(acc.id)}
                          className="w-4 h-4 rounded accent-[var(--bg-pill)]"
                        />
                        <div className="flex-1 grid grid-cols-3 gap-3">
                          <input
                            type="text"
                            value={acc.accountNumber}
                            onChange={(e) => updateManualAccount(acc.id, 'accountNumber', e.target.value)}
                            placeholder="Account #"
                            className={`${input} text-[12px]`}
                          />
                          <select
                            value={acc.accountType}
                            onChange={(e) => updateManualAccount(acc.id, 'accountType', e.target.value)}
                            className={`${input} text-[12px]`}
                          >
                            {ACCOUNT_TYPE_OPTIONS.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={acc.balance}
                            onChange={(e) => updateManualAccount(acc.id, 'balance', e.target.value)}
                            placeholder="Account value ($)"
                            className={`${input} text-[12px]`}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeManualAccount(acc.id)}
                          className="p-1.5 text-[var(--red)] hover:bg-[var(--red-light)] rounded-lg transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={addManualAccount}
                  className="w-full mt-3 py-2 border border-dashed border-[var(--border)] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[#bbb] transition-colors text-sm flex items-center justify-center gap-2"
                >
                  <Plus size={14} /> Add Account
                </button>
              </div>
            )}

            {/* Firm-of-record household sidecar (Decision log #1). */}
            {showHouseholdSidecar && householdResolution && (
              <div className="mt-4">
                <HouseholdSidecar
                  resolution={householdResolution}
                  currentlySelectedClientIds={clientIds}
                  currentlySelectedAccountIds={selectedAccountUlids()}
                  onIncludeAll={(siblingClientIds, siblingAccountUlids) => {
                    mergeSiblingsIntoSelection(siblingClientIds, siblingAccountUlids);
                    setDismissedHouseholdKey(householdResolutionKey);
                  }}
                  onIncludeSubset={(siblingClientIds, siblingAccountUlids) => {
                    mergeSiblingsIntoSelection(siblingClientIds, siblingAccountUlids);
                    setDismissedHouseholdKey(householdResolutionKey);
                  }}
                  onDismiss={dismissSidecar}
                />
              </div>
            )}

            {/* Warehouse account list */}
            {!manualClientMode && selectedClients.length > 0 && (
              <div
                className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-[10px] p-5 mt-4"
                role="group"
                aria-labelledby="advisor-form-select-accounts-label"
              >
                <div className="flex justify-between items-center mb-3">
                  <p id="advisor-form-select-accounts-label" className={`${label} mb-0`}>
                    Select Accounts
                  </p>
                  {selectedAccts.length > 0 && (
                    <span className="text-xs font-mono font-bold text-[var(--text-primary)]">
                      Total:{' '}
                      {formatCurrency(
                        allSelectedAccounts
                          .filter((a) => selectedAccts.includes(a.accountNumber))
                          .reduce((s, a) => s + a.balance, 0),
                      )}
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {selectedClients.map((client) => (
                    <div key={client.id}>
                      {selectedClients.length > 1 && (
                        <p className="text-[10px] font-bold text-[var(--text-label)] uppercase tracking-wider mt-3 mb-1.5 first:mt-0">
                          {client.name}
                        </p>
                      )}
                      {client.accounts.map((acc) => (
                        <label
                          key={acc.accountNumber}
                          className="flex items-center justify-between p-3.5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] cursor-pointer hover:border-[var(--text-muted)] hover:shadow-sm transition-all"
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={selectedAccts.includes(acc.accountNumber)}
                              onChange={() => toggleAccount(acc.accountNumber)}
                              className="w-4 h-4 rounded accent-[var(--bg-pill)]"
                            />
                            <div>
                              <p className="text-sm font-bold font-mono text-[var(--text-primary)]">
                                {acc.accountNumber}
                              </p>
                              <p className="text-xs text-[var(--text-muted)]">{acc.accountType}</p>
                            </div>
                          </div>
                          <div className="text-sm text-[var(--green)] font-mono font-bold">
                            {formatCurrency(acc.balance)}
                          </div>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>

                <div className="mt-4 rounded-[10px] border-2 border-[var(--blue-muted)]/25 bg-[var(--blue-light)]/20 p-4">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <div>
                      <div className="inline-flex items-center rounded-full border border-[var(--blue-muted)]/30 bg-[var(--bg-card)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--blue-muted)] mb-2">
                        Review Before Submit
                      </div>
                      <p className={`${label} mb-0 text-[var(--blue-muted)]`}>
                        Account-Level Standing Exclusions{' '}
                        <span className="normal-case text-[var(--text-muted)] font-medium">
                          ({accountExclusionCount} total)
                        </span>
                      </p>
                    </div>
                    {canManageAccountExclusions && (
                      <button
                        type="button"
                        onClick={() => setShowAccountExclusionsModal(true)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md border border-[var(--blue-muted)]/35 bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
                      >
                        <Settings size={12} />
                        Manage Account Restrictions
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] mb-2">
                    Account-specific standing restrictions for selected accounts. These can differ from client-level
                    exclusions.
                  </p>
                  <div className="border-t border-[var(--blue-muted)]/20 pt-3" />

                  {accountExclusionsLoading && (
                    <p className="text-xs text-[var(--text-muted)] flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" />
                      Loading account exclusions...
                    </p>
                  )}

                  {!accountExclusionsLoading && accountExclusionsError && (
                    <p className="text-xs text-[var(--red)]">{accountExclusionsError}</p>
                  )}

                  {!accountExclusionsLoading && !accountExclusionsError && accountExclusionCount === 0 && (
                    <p className="text-xs text-[var(--text-muted)]">
                      No account-specific exclusions on selected accounts.
                    </p>
                  )}

                  {!accountExclusionsLoading && !accountExclusionsError && accountExclusionCount > 0 && (
                    <div className="space-y-2">
                      {accountExclusionGroups
                        .filter((group) => group.exclusions.length > 0)
                        .map((group) => (
                          <div
                            key={group.accountId}
                            className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2"
                          >
                            <p className="text-[11px] font-bold text-[var(--text-primary)] font-mono">
                              {group.accountNumber}
                              {selectedClients.length > 1 ? ` — ${group.clientName}` : ''}
                            </p>
                            <div className="mt-2">
                              <div className="grid grid-cols-[74px_64px_minmax(0,1fr)] gap-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                                <span>Ticker</span>
                                <span>Lock</span>
                                <span>Reason</span>
                              </div>
                              <div className="mt-1 space-y-1.5 max-h-36 overflow-y-auto pr-1">
                                {group.exclusions.map((e) => {
                                  const side = formatExclusionSide(e);
                                  const reason = formatRestrictionReason(e.reason);
                                  return (
                                    <div
                                      key={e.id}
                                      className="grid grid-cols-[74px_64px_minmax(0,1fr)] gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-xs"
                                    >
                                      <span className="font-mono font-semibold text-[var(--text-primary)]">
                                        {e.ticker}
                                      </span>
                                      <span className="inline-flex w-fit items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-primary)]">
                                        {side}
                                      </span>
                                      <span className="text-[var(--text-muted)] leading-5">
                                        {reason || 'No reason provided'}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Raise Cash-specific fields ── */}
          {isRaiseCash && hasAccountSelection && (
            <div className="space-y-4">
              <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest border-b border-[var(--border)] pb-2">
                {sectionNum++}. Cash Raise Details
              </h3>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label htmlFor="advisor-form-raise-cash-amount" className={label}>
                    Cash Amount to Raise ($) <span className="text-[var(--red)]">*</span>
                  </label>
                  <p className="text-xs text-[var(--text-muted)] mb-2">
                    Target amount of cash to generate from selling securities
                  </p>
                  <input
                    id="advisor-form-raise-cash-amount"
                    type="text"
                    value={tradeAmount}
                    onChange={(e) => setTradeAmount(e.target.value)}
                    placeholder="e.g., $50,000"
                    className={input}
                  />
                </div>
                <div>
                  <label htmlFor="advisor-form-liquidity-deadline" className={label}>
                    Liquidity Deadline
                  </label>
                  <p className="text-xs text-[var(--text-muted)] mb-2">Date the cash must be settled, if applicable</p>
                  <div className="relative">
                    <input
                      id="advisor-form-liquidity-deadline"
                      type="date"
                      value={liquidityDeadline}
                      onChange={(e) => setLiquidityDeadline(e.target.value)}
                      className={input}
                    />
                    <Calendar
                      size={14}
                      className="absolute right-3 top-3 text-[var(--text-muted)] pointer-events-none"
                    />
                  </div>
                </div>
              </div>
              <div>
                <label htmlFor="advisor-form-raise-cash-reason" className={label}>
                  Reason for Cash Raise <span className="text-[var(--red)]">*</span>
                </label>
                <p className="text-xs text-[var(--text-muted)] mb-2">Purpose of the cash generation request</p>
                <textarea
                  id="advisor-form-raise-cash-reason"
                  value={raiseCashReason}
                  onChange={(e) => setRaiseCashReason(e.target.value)}
                  placeholder="e.g., Client distribution, tax payment, fee payment..."
                  rows={2}
                  className={`${input} resize-vertical`}
                />
              </div>
            </div>
          )}

          {/* ── Liquidate-specific fields ── */}
          {isLiquidate && hasAccountSelection && (
            <div className="space-y-4">
              <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest border-b border-[var(--border)] pb-2">
                {sectionNum++}. Liquidation Details
              </h3>
              <div>
                <label htmlFor="advisor-form-liquidate-option" className={label}>
                  Liquidate Options <span className="text-[var(--red)]">*</span>
                </label>
                <select
                  id="advisor-form-liquidate-option"
                  value={liquidateOption}
                  onChange={(e) => setLiquidateOption(e.target.value as LiquidateOption)}
                  className={input}
                >
                  <option value="" disabled>
                    Select liquidation option
                  </option>
                  <option value="Entire Account">Entire Account</option>
                  <option value="Specific Positions">Specific Positions</option>
                </select>
              </div>
              {liquidateOption === 'Specific Positions' && (
                <div>
                  <label htmlFor="advisor-form-liquidate-positions" className={label}>
                    Positions to Liquidate <span className="text-[var(--red)]">*</span>
                  </label>
                  <textarea
                    id="advisor-form-liquidate-positions"
                    value={liquidatePositions}
                    onChange={(e) => setLiquidatePositions(e.target.value)}
                    placeholder="e.g., AAPL, MSFT, TSLA"
                    rows={3}
                    className={`${input} resize-vertical`}
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Cash Deposit fields ── */}
          {tradeType === 'Cash Deposit' && hasAccountSelection && (
            <div className="space-y-4">
              <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest border-b border-[var(--border)] pb-2">
                {sectionNum++}. Deposit Details
              </h3>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label htmlFor="advisor-form-deposit-amount" className={label}>
                    Deposit Amount <span className="text-[var(--red)]">*</span>
                  </label>
                  <input
                    id="advisor-form-deposit-amount"
                    type="text"
                    value={tradeAmount}
                    onChange={(e) => setTradeAmount(e.target.value)}
                    placeholder="e.g., $150,000"
                    className={input}
                  />
                </div>
                <div>
                  <label htmlFor="advisor-form-deposit-account-select" className={label}>
                    Account Holding Deposit <span className="text-[var(--red)]">*</span>
                  </label>
                  <select
                    id="advisor-form-deposit-account-select"
                    value={depositAccount}
                    onChange={(e) => setDepositAccount(e.target.value)}
                    className={input}
                  >
                    <option value="" disabled>
                      Select account...
                    </option>
                    {selectedAccts.map((acct) => (
                      <option key={acct} value={acct}>
                        {acct}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <label
                htmlFor="advisor-form-rebalance-all"
                className="flex items-center gap-3 p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] cursor-pointer hover:border-[#bbb] transition-all"
              >
                <input
                  id="advisor-form-rebalance-all"
                  type="checkbox"
                  checked={rebalanceAll}
                  onChange={(e) => setRebalanceHousehold(e.target.checked)}
                  className="w-4 h-4 rounded accent-[var(--bg-pill)]"
                />
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">
                    Also rebalance all selected accounts to target allocation
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    {rebalanceAll
                      ? 'The engine will redistribute holdings across all selected accounts for this client to match the target allocation.'
                      : 'Only the deposit account will receive trades. Other selected accounts remain unchanged.'}
                  </p>
                </div>
              </label>
              <div
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3 text-xs text-[var(--text-muted)]"
                role="note"
              >
                <span className="font-semibold text-[var(--text-primary)]">Execution plan: </span>A detailed plan is not
                generated on submit for cash deposits. After you submit, a trader will verify holdings and generate the
                execution plan.
              </div>
            </div>
          )}

          {/* ── Rebalance optional deposit fields ── */}
          {tradeType === 'Rebalance' && hasAccountSelection && (
            <div className="space-y-4">
              <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest border-b border-[var(--border)] pb-2">
                {sectionNum++}. New Deposits (Optional)
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                If cash is being deposited alongside the rebalance, enter the details below. Leave blank if no deposits.
              </p>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label htmlFor="advisor-form-rebalance-deposit-amount" className={label}>
                    Deposit Amount
                  </label>
                  <input
                    id="advisor-form-rebalance-deposit-amount"
                    type="text"
                    value={tradeAmount}
                    onChange={(e) => setTradeAmount(e.target.value)}
                    placeholder="$0"
                    className={input}
                  />
                </div>
                <div>
                  <label htmlFor="advisor-form-rebalance-deposit-account" className={label}>
                    Account Holding Deposit
                  </label>
                  <select
                    id="advisor-form-rebalance-deposit-account"
                    value={depositAccount}
                    onChange={(e) => setDepositAccount(e.target.value)}
                    className={input}
                  >
                    <option value="">No deposit</option>
                    {selectedAccts.map((acct) => (
                      <option key={acct} value={acct}>
                        {acct}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {showAllocPrompt && !editRequest && primaryClientId && lastAllocLoading && (
            <p className="sr-only" aria-live="polite">
              Loading previous allocation data
            </p>
          )}

          {/* ── Previous Allocation Prompt (Rebalance / Cash Deposit) ── */}
          {isFullForm &&
            showAllocPrompt &&
            !editRequest &&
            lastAllocation &&
            usePreviousAlloc === null &&
            !lastAllocLoading && (
              <div className="bg-[var(--blue-light)] border border-[var(--blue-muted)]/20 rounded-[10px] p-5">
                <p className="text-sm font-medium text-[var(--text-primary)] mb-1">
                  This client has an existing allocation on file.
                </p>
                <p className="text-xs text-[var(--text-muted)] mb-4">
                  Risk Level {lastAllocation.riskProfile} &mdash;{' '}
                  {lastAllocation.equityStrategies.map((s) => `${s.benchmark} (${s.allocation}%)`).join(', ')}
                </p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={applyPreviousAllocation}
                    className="px-4 py-2 bg-[var(--bg-pill)] text-white rounded-lg text-[13px] font-medium hover:bg-[var(--bg-pill-hover)] transition-colors"
                  >
                    Yes, use previous allocation
                  </button>
                  <button
                    type="button"
                    onClick={declinePreviousAllocation}
                    className="px-4 py-2 bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-secondary)] rounded-lg text-[13px] font-medium hover:bg-[var(--bg-surface)] transition-colors"
                  >
                    No, start fresh
                  </button>
                </div>
              </div>
            )}

          {/* ── Mandate & Allocation (full form only) ── */}
          {isFullForm && (showAllocPrompt ? usePreviousAlloc !== null || editRequest : true) && (
            <>
              <div className="space-y-4">
                <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest border-b border-[var(--border)] pb-2">
                  {sectionNum++}. Mandate & Base Allocation
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label htmlFor="advisor-form-risk-profile" className={label}>
                      Client Risk Score
                    </label>
                    <select
                      id="advisor-form-risk-profile"
                      value={riskProfile ?? ''}
                      onChange={(e) => setRiskProfile(e.target.value === '' ? null : Number(e.target.value))}
                      className={input}
                    >
                      <option value="">— Select risk score —</option>
                      {Array.from({ length: 25 }, (_, i) => i + 1).map((num) => (
                        <option key={num} value={num}>
                          Level {num} / 25
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-[var(--text-muted)] mt-2">Determines base asset allocation.</p>
                  </div>
                  <div className="md:col-span-2">
                    <label className={label}>Resulting Base Allocation</label>
                    <div className="grid grid-cols-3 gap-3">
                      {(['equity', 'fixed', 'cash'] as const).map((key) => (
                        <div
                          key={key}
                          className="bg-[var(--bg-surface)] border border-[var(--border)] p-3.5 rounded-lg text-center"
                        >
                          <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">
                            {key === 'fixed' ? 'Fixed Inc.' : key.charAt(0).toUpperCase() + key.slice(1)}
                          </p>
                          <p className="font-serif text-xl font-medium text-[var(--text-primary)] mt-1">
                            {baseAllocation === null ? '—' : `${baseAllocation[key]}%`}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Equity Strategy */}
              <div className="space-y-4">
                <div className="flex justify-between items-end border-b border-[var(--border)] pb-2">
                  <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest">
                    {sectionNum++}. Equity Strategy Construction
                  </h3>
                  <span
                    aria-live="polite"
                    className={`text-xs font-mono font-bold px-3 py-1 rounded-md ${totalEquitySplit === 100 ? 'bg-[var(--green-light)] text-[var(--green)]' : 'bg-[var(--red-light)] text-[var(--red)]'}`}
                  >
                    {totalEquitySplit}% / 100%
                    {totalEquitySplit !== 100 && <span className="sr-only"> — must equal 100%</span>}
                  </span>
                </div>
                <p className="text-xs text-[var(--text-muted)]">
                  Distribute the <strong>{baseAllocation === null ? '—' : `${baseAllocation.equity}%`}</strong> equity
                  allocation across strategies.
                </p>
                <div className="space-y-3">
                  {equityStrats.map((strat) => {
                    const mmkMismatch = mmkMismatchByStrategyId.get(strat.id);
                    const rationaleRequired = isStrategyRationaleRequired(strat.id);
                    return (
                      <div
                        key={strat.id}
                        className="bg-[var(--bg-surface)] p-5 rounded-[10px] border border-[var(--border)] space-y-3"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex-1">
                            <label
                              htmlFor={`advisor-equity-benchmark-${strat.id}`}
                              className="text-xs text-[var(--text-muted)] block mb-1"
                            >
                              Benchmark / Strategy
                            </label>
                            <BenchmarkCombobox
                              id={`advisor-equity-benchmark-${strat.id}`}
                              value={strat.benchmark}
                              onChange={(val) => updateEquityStrat(strat.id, 'benchmark', val)}
                              className={input}
                            />
                            {mmkMismatch && (
                              <p
                                role="alert"
                                className="mt-1 text-xs text-[var(--yellow,_#92400e)] bg-[var(--yellow-light,_#fef3c7)] border border-[var(--yellow,_#92400e)]/30 rounded px-2 py-1"
                              >
                                <strong>{mmkMismatch.entered}</strong> doesn&rsquo;t match{' '}
                                {mmkMismatch.mismatchedTypes.length > 0 ? (
                                  <>
                                    the selected {mmkMismatch.mismatchedTypes.join(' / ')} account
                                    {mmkMismatch.mismatchedTypes.length > 1 ? 's' : ''}
                                    {residence !== 'Other' &&
                                    !selectedAccountTypes.every((t) => t === 'Traditional IRA' || t === 'Roth IRA')
                                      ? ` in ${residence}`
                                      : ''}
                                  </>
                                ) : (
                                  <>
                                    the {residence === 'Other' ? 'non-state-preference' : residence} residence on this
                                    request
                                  </>
                                )}
                                . Expected: <strong>{mmkMismatch.expected.join(' or ')}</strong>. Provide a Strategy
                                Rationale below to override.
                              </p>
                            )}
                          </div>
                          <div className="w-32">
                            <label
                              htmlFor={`advisor-equity-allocation-${strat.id}`}
                              className="text-xs text-[var(--text-muted)] block mb-1"
                            >
                              % of Equity
                            </label>
                            <div className="relative">
                              <input
                                id={`advisor-equity-allocation-${strat.id}`}
                                type="number"
                                value={strat.allocation}
                                onChange={(e) => updateEquityStrat(strat.id, 'allocation', e.target.value)}
                                className={`${input} pr-6`}
                              />
                              <span className="absolute right-3 top-2.5 text-[var(--text-muted)] text-sm">%</span>
                            </div>
                          </div>
                          {equityStrats.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeEquityStrat(strat.id)}
                              aria-label="Remove equity strategy"
                              className="mt-5 p-2 text-[var(--red)] hover:bg-[var(--red-light)] rounded-lg transition-colors"
                            >
                              <Trash2 size={18} />
                            </button>
                          )}
                        </div>
                        <div>
                          <Tooltip
                            content={
                              mmkMismatch
                                ? `Required because ${mmkMismatch.entered} doesn't match the selected account type / residence. Document why this MMK is being used.`
                                : shouldRequireStrategyRationale
                                  ? 'Required when setting a new or materially changed allocation.'
                                  : 'Optional because this allocation matches the last approved or completed allocation.'
                            }
                            position="right"
                          >
                            <label
                              htmlFor={`advisor-equity-rationale-${strat.id}`}
                              className="text-xs text-[var(--text-muted)] block mb-1"
                            >
                              Strategy Rationale (Reg BI){' '}
                              {rationaleRequired ? (
                                <span className="text-[var(--red)]">*</span>
                              ) : (
                                <span className="font-normal text-[var(--text-muted)]">(Optional)</span>
                              )}
                            </label>
                          </Tooltip>
                          <textarea
                            id={`advisor-equity-rationale-${strat.id}`}
                            value={strat.rationale}
                            onChange={(e) => updateEquityStrat(strat.id, 'rationale', e.target.value)}
                            placeholder={`Why ${strat.benchmark || 'this strategy'} is in the client's best interest...`}
                            rows={2}
                            maxLength={MAX_RATIONALE_CHARS}
                            className={`${input} resize-vertical`}
                          />
                          <div
                            className={`mt-1 text-[11px] text-right tabular-nums ${
                              strat.rationale.length >= MAX_RATIONALE_CHARS
                                ? 'text-[var(--red)]'
                                : strat.rationale.length >= MAX_RATIONALE_CHARS * 0.9
                                  ? 'text-[var(--yellow,_#92400e)]'
                                  : 'text-[var(--text-muted)]'
                            }`}
                            aria-live="polite"
                          >
                            {strat.rationale.length.toLocaleString()} / {MAX_RATIONALE_CHARS.toLocaleString()}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {equityStrats.length < 3 && (
                  <button
                    type="button"
                    onClick={addEquityStrat}
                    className="w-full py-2.5 border border-dashed border-[var(--border)] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[#bbb] transition-colors text-sm flex items-center justify-center gap-2"
                  >
                    <Plus size={16} /> Add Another Equity Strategy ({equityStrats.length}/3)
                  </button>
                )}
              </div>

              {/* Compliance & Exclusions */}
              <div className="space-y-4">
                <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest border-b border-[var(--border)] pb-2">
                  {sectionNum++}. Compliance, Exclusions & Execution
                </h3>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <Tooltip content="Used for municipal bond tax optimization" position="right">
                      <label htmlFor="advisor-form-residence" className={label}>
                        State Residence
                      </label>
                    </Tooltip>
                    <select
                      id="advisor-form-residence"
                      value={residence}
                      onChange={(e) => setResidence(e.target.value as Residence)}
                      className={input}
                    >
                      <option value="Other">Other / Not Applicable</option>
                      <option value="NY">New York (NY) - Muni Preference</option>
                      <option value="CA">California (CA) - Muni Preference</option>
                    </select>
                  </div>
                  <div>
                    <Tooltip content="Confirms client approves selling existing holdings" position="left">
                      <label htmlFor="advisor-form-liquidation-approval" className={label}>
                        Liquidation Approval
                      </label>
                    </Tooltip>
                    <select
                      id="advisor-form-liquidation-approval"
                      value={liquidationApproval}
                      onChange={(e) => setLiquidationApproval(e.target.value as 'Yes' | 'No')}
                      className={input}
                    >
                      <option value="" disabled>
                        Select...
                      </option>
                      <option value="Yes">Yes</option>
                      <option value="No">No</option>
                    </select>
                  </div>
                </div>
                <div>
                  <Tooltip content="Exclude sectors from the direct indexing universe" position="right">
                    <label className={label}>ESG Filters (Direct Indexing)</label>
                  </Tooltip>
                  <div className="bg-[var(--bg-surface)] p-4 rounded-lg border border-[var(--border)] space-y-3">
                    <div className="flex flex-wrap gap-5">
                      {(['fossilFuels', 'tobacco', 'weapons', 'alcohol', 'gambling', 'other', 'none'] as const).map(
                        (key) => (
                          <label
                            key={key}
                            className="flex items-center space-x-2 cursor-pointer text-sm text-[var(--text-secondary)]"
                          >
                            <input
                              type="checkbox"
                              checked={esgFilters[key]}
                              onChange={() => toggleEsg(key)}
                              className="rounded accent-[var(--bg-pill)]"
                            />
                            <span>{ESG_LABELS[key]}</span>
                          </label>
                        ),
                      )}
                    </div>
                    {esgFilters.other && (
                      <input
                        type="text"
                        value={esgFilters.otherDescription}
                        onChange={(e) => setEsgFilters((prev) => ({ ...prev, otherDescription: e.target.value }))}
                        placeholder="Specify custom ESG filter..."
                        className={`${input} mt-1`}
                      />
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <label htmlFor="advisor-form-advisor-exclusions" className={label}>
                        Advisor Specific Exclusions
                      </label>
                      <textarea
                        id="advisor-form-advisor-exclusions"
                        value={advisorExclusions}
                        onChange={(e) => setAdvisorExclusions(e.target.value)}
                        placeholder="e.g., TSLA (Concentration risk)"
                        rows={3}
                        className={`${input} resize-vertical`}
                      />
                    </div>
                    <div>
                      <label htmlFor="advisor-form-client-exclusions" className={label}>
                        Client Requested Exclusions
                      </label>
                      <textarea
                        id="advisor-form-client-exclusions"
                        value={clientExclusions}
                        onChange={(e) => setClientExclusions(e.target.value)}
                        placeholder="e.g., AAPL (Employer stock)"
                        rows={3}
                        className={`${input} resize-vertical`}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ── Workflow & Advisor Notes (all types) ── */}
          <div className="space-y-4">
            <h3 className="text-[11px] font-bold text-[var(--text-label)] uppercase tracking-widest border-b border-[var(--border)] pb-2">
              {sectionNum}. Workflow & Advisor Notes
            </h3>
            <div>
              <label htmlFor="advisor-form-advisor-notes" className={label}>
                Advisor Compliance & Execution Notes
              </label>
              <textarea
                id="advisor-form-advisor-notes"
                value={advisorNotes}
                onChange={(e) => setAdvisorNotes(e.target.value)}
                placeholder="e.g., Prioritize sale of lowest basis tax lots first. Maintain 3% minimum cash position post-trade."
                rows={3}
                className={`${input} resize-vertical`}
              />
            </div>
          </div>
        </div>

        <div className="px-7 py-4 border-t border-[var(--border)] flex justify-end gap-3">
          {(isEditing || isCloning) && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
          )}
          <button
            disabled={isFormInvalid || isSubmitting}
            onClick={handleSubmit}
            aria-describedby={submitError ? 'advisor-form-submit-error' : undefined}
            className="bg-[var(--bg-pill)] hover:bg-[var(--bg-pill-hover)] text-white px-6 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
          >
            {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {isSubmitting
              ? 'Submitting...'
              : isEditing
                ? 'Resubmit to Trader'
                : tradeType === 'Initial Funding'
                  ? 'Generate Plan & Submit'
                  : 'Submit Trade Request'}
          </button>
        </div>
      </div>

      {showExclusionsModal && canManageExclusions && (
        <ManageExclusionsModal
          clients={selectedClients.map((c) => ({ id: c.id, name: c.name }))}
          onClose={() => setShowExclusionsModal(false)}
          onSavedChanges={handleExclusionsSaved}
        />
      )}
      {showAccountExclusionsModal && canManageAccountExclusions && (
        <ManageExclusionsModal
          mode="account"
          accounts={selectedAccountTargets}
          onClose={() => setShowAccountExclusionsModal(false)}
          onSavedChanges={handleAccountExclusionsSaved}
        />
      )}
    </div>
  );
}
