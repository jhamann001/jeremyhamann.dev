import { useMemo, useState, type ReactElement } from 'react';
import { Users, X, ChevronDown } from 'lucide-react';
import type { HouseholdResolveResponse, HouseholdResolution } from '@trade-request/shared';

export interface HouseholdSidecarProps {
  resolution: HouseholdResolveResponse;
  currentlySelectedClientIds: readonly string[];
  /** Apex ULIDs (`Account.id`) of currently selected accounts in the form. */
  currentlySelectedAccountIds: readonly string[];
  /**
   * Include every not-yet-selected sibling under the resolved household.
   * `clientIds` are distinct Warehouse Client.id values; `accountIds` are
   * Apex ULIDs. The parent (`AdvisorForm`) translates ULIDs back to
   * human-readable account numbers before merging into `selectedAccts`.
   */
  onIncludeAll: (clientIds: string[], accountIds: string[]) => void;
  /** Same payload shape as `onIncludeAll`, but the advisor cherry-picked from the disclosure. */
  onIncludeSubset: (clientIds: string[], accountIds: string[]) => void;
  onDismiss: () => void;
}

/**
 * Surfaces the firm-of-record household for the advisor's current selection
 * and PROMPTS them to include sibling accounts (Decision log #1 in
 * `docs/plans/2026-q2-trade-request-householding.md`). Three render states:
 *
 *   1. Hidden — no households resolved, OR every resolved household's
 *      `accounts` is already covered by the current selection.
 *   2. Single-household prompt — 1 household with ≥1 not-yet-selected sibling.
 *   3. Multi-household warning — 2+ households (no auto-add).
 *
 * Purely presentational: the parent owns selection state and persistence.
 * Dismissing this sidecar does NOT influence the persisted `householdId`
 * tag — that's computed at submit time from the final selected ULID set
 * (Decision log #5).
 */
export function HouseholdSidecar(props: HouseholdSidecarProps): ReactElement | null {
  const {
    resolution,
    currentlySelectedClientIds,
    currentlySelectedAccountIds,
    onIncludeAll,
    onIncludeSubset,
    onDismiss,
  } = props;

  const selectedAcctSet = useMemo(() => new Set(currentlySelectedAccountIds), [currentlySelectedAccountIds]);
  const selectedClientSet = useMemo(() => new Set(currentlySelectedClientIds), [currentlySelectedClientIds]);

  const householdsWithSiblings = useMemo(
    () =>
      resolution.households
        .map((h) => ({
          household: h,
          missingAccounts: h.accounts.filter((a) => !selectedAcctSet.has(a.accountId)),
        }))
        .filter((row) => row.missingAccounts.length > 0),
    [resolution.households, selectedAcctSet],
  );

  if (householdsWithSiblings.length === 0) return null;

  if (householdsWithSiblings.length === 1) {
    return (
      <SingleHouseholdPrompt
        row={householdsWithSiblings[0]}
        selectedClientSet={selectedClientSet}
        onIncludeAll={onIncludeAll}
        onIncludeSubset={onIncludeSubset}
        onDismiss={onDismiss}
      />
    );
  }

  return <MultiHouseholdWarning rows={householdsWithSiblings} onDismiss={onDismiss} />;
}

// ─── Single-household prompt ────────────────────────────────────────────────

interface SingleRowProps {
  row: { household: HouseholdResolution; missingAccounts: HouseholdResolution['accounts'] };
  selectedClientSet: Set<string>;
  onIncludeAll: HouseholdSidecarProps['onIncludeAll'];
  onIncludeSubset: HouseholdSidecarProps['onIncludeSubset'];
  onDismiss: HouseholdSidecarProps['onDismiss'];
}

function SingleHouseholdPrompt(props: SingleRowProps): ReactElement {
  const { row, selectedClientSet, onIncludeAll, onIncludeSubset, onDismiss } = props;
  const { household, missingAccounts } = row;

  const [showDisclosure, setShowDisclosure] = useState(false);
  const [chosenSet, setChosenSet] = useState<Set<string>>(() => new Set(missingAccounts.map((a) => a.accountId)));

  const siblingClientCount = new Set(missingAccounts.map((a) => a.clientId).filter((c): c is string => c !== null))
    .size;

  const handleIncludeAll = (): void => {
    const ulids = missingAccounts.map((a) => a.accountId);
    const clientIds = Array.from(
      new Set(
        missingAccounts.map((a) => a.clientId).filter((c): c is string => c !== null && !selectedClientSet.has(c)),
      ),
    );
    onIncludeAll(clientIds, ulids);
  };

  const handleIncludeSubset = (): void => {
    const chosen = missingAccounts.filter((a) => chosenSet.has(a.accountId));
    const ulids = chosen.map((a) => a.accountId);
    const clientIds = Array.from(
      new Set(chosen.map((a) => a.clientId).filter((c): c is string => c !== null && !selectedClientSet.has(c))),
    );
    onIncludeSubset(clientIds, ulids);
  };

  const toggleAccount = (ulid: string): void => {
    setChosenSet((prev) => {
      const next = new Set(prev);
      if (next.has(ulid)) next.delete(ulid);
      else next.add(ulid);
      return next;
    });
  };

  return (
    <div
      role="region"
      aria-label="Household sidecar"
      data-testid="household-sidecar"
      className="bg-[var(--blue-light,_#eff6ff)] border border-[var(--blue-border,_#bfdbfe)] rounded-xl px-4 py-3 text-[13px] text-[var(--text-default,_#1e3a8a)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Users size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">
              {missingAccounts.length} sibling account{missingAccounts.length === 1 ? '' : 's'}
              {siblingClientCount > 0 && (
                <>
                  {' '}
                  in {siblingClientCount} other client{siblingClientCount === 1 ? '' : 's'}
                </>
              )}{' '}
              — part of household <strong>{household.householdName}</strong>
            </div>
            <div className="text-[12px] text-[var(--text-muted,_#475569)] mt-0.5">Include them in this trade?</div>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss household sidecar"
          onClick={onDismiss}
          className="text-[var(--text-muted,_#475569)] hover:text-[var(--text-default,_#1e3a8a)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 items-center">
        <button
          type="button"
          data-testid="household-include-all"
          onClick={handleIncludeAll}
          className="text-[12px] font-medium rounded-md px-3 py-1.5 bg-[var(--blue,_#2563eb)] text-white hover:opacity-90"
        >
          Include all
        </button>
        <button
          type="button"
          data-testid="household-toggle-disclosure"
          onClick={() => setShowDisclosure((v) => !v)}
          className="text-[12px] font-medium rounded-md px-3 py-1.5 bg-white border border-[var(--border,_#cbd5e1)] hover:bg-[var(--gray-50,_#f8fafc)] inline-flex items-center gap-1"
          aria-expanded={showDisclosure}
        >
          Choose… <ChevronDown size={12} className={showDisclosure ? 'rotate-180 transition' : 'transition'} />
        </button>
        <button
          type="button"
          data-testid="household-dismiss"
          onClick={onDismiss}
          className="text-[12px] text-[var(--text-muted,_#475569)] hover:text-[var(--text-default,_#1e3a8a)] underline"
        >
          Dismiss
        </button>
      </div>

      {showDisclosure && (
        <div className="mt-3 border-t border-[var(--blue-border,_#bfdbfe)] pt-3 space-y-1">
          {missingAccounts.map((a) => (
            <label
              key={a.accountId}
              className="flex items-center gap-2 text-[12px] cursor-pointer"
              data-testid={`household-sibling-${a.accountId}`}
            >
              <input type="checkbox" checked={chosenSet.has(a.accountId)} onChange={() => toggleAccount(a.accountId)} />
              <span>
                <strong>{a.accountTitle || a.accountNumber || a.accountId}</strong>
                {a.accountNumber && a.accountTitle ? (
                  <span className="text-[var(--text-muted,_#475569)]"> · {a.accountNumber}</span>
                ) : null}
              </span>
            </label>
          ))}
          <div className="pt-2">
            <button
              type="button"
              data-testid="household-include-subset"
              onClick={handleIncludeSubset}
              disabled={chosenSet.size === 0}
              className="text-[12px] font-medium rounded-md px-3 py-1.5 bg-[var(--blue,_#2563eb)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Include selected ({chosenSet.size})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Multi-household warning ────────────────────────────────────────────────

interface MultiRowsProps {
  rows: Array<{ household: HouseholdResolution; missingAccounts: HouseholdResolution['accounts'] }>;
  onDismiss: HouseholdSidecarProps['onDismiss'];
}

function MultiHouseholdWarning(props: MultiRowsProps): ReactElement {
  const { rows, onDismiss } = props;
  return (
    <div
      role="region"
      aria-label="Household sidecar"
      data-testid="household-sidecar-multi"
      className="bg-[var(--yellow-light,_#fff7e6)] border border-[var(--yellow-border,_#f5c97a)] rounded-xl px-4 py-3 text-[13px] text-[var(--yellow,_#92400e)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Users size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Selection spans {rows.length} firm households</div>
            <ul className="mt-1 text-[12px] list-disc pl-5">
              {rows.map((r) => (
                <li key={r.household.householdId}>
                  <strong>{r.household.householdName}</strong> — {r.missingAccounts.length} sibling account
                  {r.missingAccounts.length === 1 ? '' : 's'} not in this trade
                </li>
              ))}
            </ul>
            <div className="text-[12px] mt-2 text-[var(--text-muted,_#475569)]">
              The trade will not be tagged to a single household.
            </div>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss household sidecar"
          onClick={onDismiss}
          className="text-[var(--text-muted,_#475569)] hover:text-[var(--yellow,_#92400e)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 items-center">
        <button
          type="button"
          data-testid="household-continue"
          onClick={onDismiss}
          className="text-[12px] font-medium rounded-md px-3 py-1.5 bg-white border border-[var(--yellow-border,_#f5c97a)] hover:bg-[var(--yellow-light,_#fff7e6)]"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
